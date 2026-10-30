const admin = require('firebase-admin');
const crypto = require('node:crypto');
const { isActive, problem, assertDispatchSession } = require('../server/license-integrity.cjs');

// Public clients receive a projection, never Firestore documents or driver contact data.
const DAY = 86400000;
const dayOf = value => new Date(value + 9 * 3600000).toISOString().slice(0, 10);
const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
function phoneOf(value) {
    let phone = String(value || '').replace(/\D/g, '');
    if (phone.startsWith('82')) phone = '0' + phone.slice(2);
    return /^010\d{8}$/.test(phone) ? phone : '';
}
function trackingLookupKeys(date, items, owner = '') {
    const day = String(date || '').split('-').map((v,i) => i ? v.padStart(2,'0') : v).join('-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    const keys = new Set(owner ? [JSON.stringify([day,'owner',owner])] : []);
    for (const item of items || []) {
        let phone = String(item?.customerPhone || item?.phone || '').replace(/\D/g,'');
        if (phone.startsWith('82')) phone = '0' + phone.slice(2);
        if (/^010\d{8}$/.test(phone)) keys.add(JSON.stringify([day,'phone',phone]));
        const order = String(item?.orderNo || '').trim().replace(/\s+/g,' ');
        if (order) keys.add(JSON.stringify([day,'order',order]));
    }
    return [...keys];
}

function addressOf(item) {
    const address = clean(item.fullAddress || item.address), prefix = '[' + clean(item.storeName) + ']';
    return address.startsWith(prefix) ? address.slice(prefix.length).trim() : address;
}
function latestRoute(routes, owner) {
    return routes.filter(r => r.routeOwnerId === owner && Number.isFinite(r.updatedAt) &&
        (Array.isArray(r.destinations) || r.cleared === true))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.documentId.localeCompare(b.documentId))[0];
}
function routeDay(route) {
    const plan = route?.routePlan;
    return plan?.ownerId === route.routeOwnerId && /^\d{4}-\d{1,2}-\d{1,2}$/.test(plan.date || '')
        ? plan.date.split('-').map((v, i) => i ? v.padStart(2, '0') : v).join('-') : dayOf(route.updatedAt);
}
function routeItems(route) { return route.cleared ? [] : route.destinations || []; }
function snapshotFor(orders, drivers, routes, date) {
    const rows = orders.filter(o => o && typeof o === 'object').map(o => ({ ...o }));
    const originalCount = rows.length, consumed = new Set(), plans = {};
    for (const driver of drivers) {
        const route = latestRoute(routes, driver.routeOwnerId);
        if (!route || routeDay(route) !== date) continue;
        const key = driver.key;
        const items = routeItems(route);
        const planIds = route.routePlan?.ownerId === driver.routeOwnerId ? route.routePlan.orderIds : null;
        const ids = [...(Array.isArray(planIds) ? planIds.map(String) : []), ...items.map(d => String(d.id))];
        const slots = new Map();
        for (const id of [...new Set(ids)]) {
            const item = items.find(d => String(d.id) === id);
            const phone = item && phoneOf(item.phone), address = item && addressOf(item);
            const groupKey = phone && address ? JSON.stringify([phone, address]) : 'id:' + id;
            if (!slots.has(groupKey)) slots.set(groupKey, []);
            slots.get(groupKey).push(id);
        }
        plans[key] = { owner: driver.routeOwnerId, name: clean(driver.name) || '담당 기사',
            routeId: route.routePlan?.routeId || '', slots: [...slots.values()].map(ids => ({ ids })), updatedAt: route.updatedAt };
        for (const item of items) {
            const matches = rows.slice(0, originalCount).map((o, index) => ({ o, index })).filter(({ o }) =>
                String(o.assignedDriver || '') === key && (clean(item.orderNo) && clean(o.orderNo)
                    ? clean(item.orderNo) === clean(o.orderNo) : item.id != null && o.id != null && String(item.id) === String(o.id)));
            const row = { ...item, assignedDriver: key, _destinationId: item.id == null ? '' : String(item.id) };
            if (matches.length === 1 && !consumed.has(matches[0].index)) {
                const index = matches[0].index; consumed.add(index); rows[index] = { ...rows[index], ...row };
            } else rows.push(row);
        }
    }
    const groups = new Map();
    for (const row of rows) {
        const phone = phoneOf(row.phone); if (!phone) continue;
        const address = addressOf(row), number=/^[A-Za-z0-9]{5}$/.test(row.deliveryNumber||'')?row.deliveryNumber:'', key = JSON.stringify([phone, address, number]);
        if (!groups.has(key)) groups.set(key, { phone, address, deliveryNumber:number, orders: [], drivers: new Set(), ids: new Set(), invalid: false });
        const group = groups.get(key), driver = String(row.assignedDriver || '');
        group.orders.push(clean(row.orderNo)); group.drivers.add(driver);
        let id = row._destinationId;
        if (!id && plans[driver]) {
            const route = latestRoute(routes, plans[driver].owner);
            const candidates = routeItems(route).filter(item => phoneOf(item.phone) === phone && addressOf(item) === address);
            if (candidates.length === 1) id = String(candidates[0].id ?? '');
        }
        if (id) group.ids.add(id);
        if (!address || !driver || !plans[driver] || !id) group.invalid = true;
    }
    const stops = [...groups.values()].map(g => ({ phone: g.phone, address: g.address,
        ...(g.deliveryNumber ? {deliveryNumber:g.deliveryNumber} : {}),
        orders: [...new Set(g.orders.filter(Boolean))], driver: [...g.drivers][0], ids: [...g.ids],
        invalid: g.invalid || g.drivers.size !== 1 }));
    return { plans, stops };
}
function projectTracking(publication, phone, liveRoutes, deliveryNumber = '') {
    const ownStops = publication.stops.filter(stop => stop.phone === phone && (!deliveryNumber || stop.deliveryNumber === deliveryNumber));
    return { company: publication.company, date: publication.date, expiresAt: publication.expiresAt,
        updatedAt: Date.now(), stops: ownStops.map(stop => {
            const plan = publication.plans[stop.driver];
            if (!plan || !stop.ids.length) return { address: stop.address, orders: stop.orders, ...(stop.deliveryNumber?{deliveryNumber:stop.deliveryNumber}:{}),
                status: 'preparing', sequence: [], route: [] };
            const route = latestRoute(liveRoutes, plan.owner);
            const sameDay = route && routeDay(route) === publication.date;
            const samePlan = sameDay && route.cleared !== true && (plan.routeId
                ? route.routePlan?.ownerId === plan.owner && route.routePlan?.routeId === plan.routeId
                : route.updatedAt === plan.updatedAt);
            const entries = samePlan && Array.isArray(route.routePlan?.deliveries) ? route.routePlan.deliveries : [];
            const activeIds = samePlan ? new Set(routeItems(route).map(d => String(d.id))) : new Set();
            const states = new Map(entries.map(entry => [String(entry.id), entry.status]));
            for (const id of stop.ids) if (!states.has(id) && publication.completionStates?.[stop.driver]?.[id]) states.set(id, publication.completionStates[stop.driver][id]);
            const statusOf = id => !samePlan ? 'checking' : activeIds.has(id) ? 'pending'
                : states.get(id) === 'completed' ? 'completed' : states.get(id) === 'cancelled' ? 'cancelled' : 'checking';
            const completedTime = ids => {
                const times = ids.map(id => publication.completionTimes?.[stop.driver]?.[id]);
                return ids.length && ids.every(id => statusOf(id) === 'completed') && times.every(t => Number.isFinite(t) && t > 0)
                    ? Math.max(...times) : null;
            };
            const statuses = stop.ids.map(statusOf);
            const status = statuses.every(s => s === 'completed') ? 'completed'
                : statuses.every(s => s === 'cancelled') ? 'cancelled'
                : statuses.includes('checking') ? 'checking' : statuses.some(s => s === 'completed' || s === 'cancelled') ? 'partial' : 'pending';
            // Reflect re-optimization/additional stops while keeping completed orders grouped.
            // Firestore stores each group as an object; arrays cannot directly contain arrays.
            const savedSlots = plan.slots.map(group => group.ids);
            let slots = savedSlots;
            if (samePlan && Array.isArray(route.routePlan?.orderIds)) {
                const groupForId = new Map();
                for (const group of publication.stops.filter(s => s.driver === stop.driver))
                    for (const id of group.ids) groupForId.set(id, JSON.stringify([group.phone, group.address]));
                for (const item of routeItems(route)) {
                    const phone = phoneOf(item.phone), address = addressOf(item);
                    if (phone && address) groupForId.set(String(item.id), JSON.stringify([phone, address]));
                }
                const ordered = [...new Set([...route.routePlan.orderIds.map(String), ...routeItems(route).map(d => String(d.id)), ...savedSlots.flat()])];
                const grouped = new Map();
                for (const id of ordered) {
                    const key = groupForId.get(id) || 'id:' + id;
                    if (!grouped.has(key)) grouped.set(key, []);
                    grouped.get(key).push(id);
                }
                slots = [...grouped.values()];
            }
            const sequence = slots.flatMap((ids, i) => ids.some(id => stop.ids.includes(id)) ? [i + 1] : []);
            const addresses = new Map();
            for (const group of publication.stops.filter(s => s.driver === stop.driver))
                for (const id of group.ids) addresses.set(id, clean(group.address));
            for (const entry of entries) if (!addresses.get(String(entry.id))) addresses.set(String(entry.id), clean(entry.item?.address));
            for (const item of samePlan ? routeItems(route) : []) addresses.set(String(item.id), addressOf(item));
            const routeList = slots.map((ids, i) => {
                    const statuses = ids.map(statusOf);
                    const status = statuses.every(s => s === 'completed') ? 'completed'
                        : statuses.every(s => s === 'cancelled') ? 'cancelled'
                        : statuses.includes('checking') ? 'checking' : 'pending';
                    return { sequence: i + 1, own: ids.some(id => stop.ids.includes(id)), status,
                        address: ids.map(id => addresses.get(id)).find(Boolean) || '', completedAt: completedTime(ids) };
                });
            // The first remaining delivery is the next destination in the saved route, not GPS evidence.
            const next = routeList.find(s => s.status !== 'completed' && s.status !== 'cancelled');
            if (next?.status === 'pending') next.status = 'moving';
            return { address: stop.address, orders: stop.orders, ...(stop.deliveryNumber?{deliveryNumber:stop.deliveryNumber}:{}), status, sequence, completedAt: completedTime(stop.ids), route: routeList };
        }) };
}
// All customer reads start with indexed discovery; there is no whole-day fallback scan.
function lookupKey(date, lookup) {
    const phone = phoneOf(lookup);
    return JSON.stringify([date,phone ? 'phone' : 'order',phone || clean(lookup)]);
}
async function ownerCompletions(db, owners, date) {
    const start = Date.parse(date + 'T00:00:00+09:00');
    const snapshots = await Promise.all(owners.map(owner => db.collection('completions')
        .where('trackingLookupKeys','array-contains',JSON.stringify([date,'owner',owner])).get()));
    return snapshots.flatMap((s,i) => s.docs.map(d => d.data()).filter(r =>
        r.routeOwnerId === owners[i] && r.completedAt >= start && r.completedAt < start + DAY));
}
async function livePublications(db, date, now, lookup, expandPhone = true, seed = {}) {
    const start = Date.parse(date + 'T00:00:00+09:00'), key = lookupKey(date,lookup);
    const phone = phoneOf(lookup), number=/^[A-Za-z0-9]{5}$/.test(lookup)?lookup:'';
    const matches = item => number ? item.deliveryNumber===number : phone ? phoneOf(item.customerPhone || item.phone) === phone : clean(item.orderNo) === clean(lookup);
    const [foundRoutes, orders, foundCompletions] = await Promise.all(
        ['routes','dispatch_orders','completions'].map(name => db.collection(name).where('trackingLookupKeys','array-contains',key).get()));
    const owners = new Set(foundRoutes.docs.map(d => d.data().routeOwnerId));
    if(seed.owner)owners.add(seed.owner);
    if(seed.company){
        const stored=await db.collection('dispatch_orders').doc(`${date}_${seed.company}`).get();
        if(stored.exists)orders.docs.push(stored);
    }
    for (const d of foundCompletions.docs) if (matches(d.data())) owners.add(d.data().routeOwnerId);
    owners.delete(undefined); owners.delete('');
    const assignedKeys = new Set(orders.docs.flatMap(d => (d.data().orders || []).filter(matches).map(o => o.assignedDriver)).filter(Boolean));
    const [ownerLicenses, assignedLicenses] = await Promise.all([
        Promise.all([...owners].map(owner => db.collection('licenses').where('routeOwnerId','==',owner).get())),
        Promise.all([...assignedKeys].map(key => db.collection('licenses').doc(key).get()))
    ]);
    const driverMap = new Map([...ownerLicenses.flatMap(s => s.docs),...assignedLicenses]
        .filter(d => d.exists).map(d => [d.id,{...d.data(),key:d.id}]));
    const companyKeys = new Set([...driverMap.values()].map(d => d.dispatchKey).filter(Boolean));
    if(seed.company)companyKeys.add(seed.company);
    for (const d of orders.docs) if ((d.data().orders || []).some(matches)) companyKeys.add(d.data().dispatchKey || d.id.slice(date.length + 1));
    const companies = await Promise.all([...companyKeys].filter(Boolean).map(key => db.collection('licenses').doc(key).get()));
    const allLicenses = [...driverMap.values(),...companies.filter(d => d.exists).map(d => ({...d.data(),key:d.id}))];
    const activeCompanies = new Set(allLicenses.filter(l => l.type === 'dispatch' && isActive(l,dayOf(now),now)).map(l => l.key));
    const selectedOwners = [...new Set([...driverMap.values()].filter(d => activeCompanies.has(d.dispatchKey)).map(d => d.routeOwnerId).filter(Boolean))];
    const [routeDocs, completions] = await Promise.all([
        Promise.all(selectedOwners.map(owner => db.collection('routes').where('routeOwnerId','==',owner).get())),
        ownerCompletions(db,selectedOwners,date)
    ]);
    const routes = routeDocs.flatMap(s => s.docs.map(d => ({...d.data(),documentId:d.id})));
    completions.sort((a,b) => a.completedAt - b.completedAt);
    const publications = [];
    for (const company of allLicenses.filter(l => l.type === 'dispatch' && isActive(l, dayOf(now), now))) {
        const drivers = allLicenses.filter(l => l.type !== 'dispatch' && l.dispatchKey === company.key && l.routeOwnerId);
        const ownerKeys = new Map(drivers.map(d => [d.routeOwnerId, d.key]));
        const rows = orders.docs.filter(d => d.data().dispatchKey === company.key || d.id === `${date}_${company.key}`)
            .flatMap(d => Array.isArray(d.data().orders) ? d.data().orders.map(o => ({ ...o })) : []);
        const companyRoutes = routes.filter(r => ownerKeys.has(r.routeOwnerId));
        const completionStates = {}, completionTimes = {};
        for (const record of completions) {
            const driver = ownerKeys.get(record.routeOwnerId), id = record.destinationId == null ? '' : String(record.destinationId);
            if (!driver || !id) continue;
            const route = latestRoute(companyRoutes, record.routeOwnerId);
            if (route?.cleared || (route?.routePlan?.ownerId === record.routeOwnerId && route.routePlan.date &&
                (routeDay(route) !== date || !route.routePlan.orderIds?.map(String).includes(id)))) continue;
            const status = record.tag === '배송 취소' ? 'cancelled'
                : ['배송 완료','완료','직접 전달','사진 완료','문 앞','주방'].includes(record.tag) || /^기타\s*:/.test(record.tag || '') ? 'completed' : '';
            if (!status) continue;
            (completionStates[driver] ||= {})[id] = status;
            (completionTimes[driver] ||= {})[id] = status === 'completed' ? record.completedAt : null;
            const match = rows.find(o => String(o.assignedDriver || '') === driver &&
                (String(o.id ?? '') === id || clean(record.orderNo) && clean(o.orderNo) === clean(record.orderNo)));
            const active = route && routeItems(route).some(d => String(d.id) === id);
            if (active) continue;
            if (match) match._destinationId = id;
            else if (phoneOf(record.customerPhone)) rows.push({ phone: record.customerPhone, fullAddress: record.fullAddress || record.address,
                orderNo: record.orderNo, assignedDriver: driver, _destinationId: id });
        }
        const snapshot = snapshotFor(rows, drivers, companyRoutes, date);
        for (const driver of drivers) if (!snapshot.plans[driver.key]) snapshot.plans[driver.key] = {
            owner: driver.routeOwnerId, name: clean(driver.name) || '담당 기사', routeId: '', slots: [], updatedAt: 0
        };
        publications.push({ ...snapshot, completionStates, completionTimes, dispatchKey: company.key, company: clean(company.companyName || company.name) || '배송업체',
            date, expiresAt: start + 8 * DAY });
    }
    const index = {publications,routes};
    if (!phone && expandPhone && !/^[A-Za-z0-9]{5}$/.test(lookup)) {
        // An order search still shows all of that customer's stops in the matching companies.
        const matched = publications.flatMap(p => p.stops.filter(s => s.orders.includes(clean(lookup))).map(s => ({company:p.dispatchKey,phone:s.phone})));
        if (matched.length) {
            lookupPublicData(index,clean(lookup),now); // Preserve ambiguous-order rejection before expanding.
            const expanded = await livePublications(db,date,now,matched[0].phone,false);
            const allowed = new Set(matched.map(m => m.company));
            return {...expanded,publications:expanded.publications.filter(p => allowed.has(p.dispatchKey))};
        }
    }
    return index;
}
function lookupPublicData(index, lookup, now) {
    const phone = phoneOf(lookup);
    const number=/^[A-Za-z0-9]{5}$/.test(lookup)?lookup:'';
    const matches = index.publications.flatMap(publication => publication.stops
        .filter(stop => number ? stop.deliveryNumber===number : phone ? stop.phone === phone : stop.orders.includes(lookup))
        .map(stop => ({ publication, phone: stop.phone })));
    if (!matches.length) throw problem('입력한 정보와 일치하는 배송이 없습니다. 배송일과 받는 분의 전화번호 또는 주문번호를 확인해 주세요.', 404);
    if (!phone && new Set(matches.map(m => m.phone)).size !== 1) throw problem('같은 주문번호가 여러 고객에게 등록되어 있습니다. 받는 분의 전화번호로 조회해 주세요.', 409);
    const selectedPhone = phone || matches[0].phone, selected = [...new Set(matches.map(m => m.publication))];
    const results = selected.map(p => projectTracking(p, selectedPhone, index.routes,number));
    const companyNames = [...new Set(selected.map(p => p.company))];
    return { company: companyNames.length === 1 ? companyNames[0] : '내 배송', date: selected[0].date,
        expiresAt: Math.min(...selected.map(p => p.expiresAt)), updatedAt: now,
        stops: results.flatMap((result, i) => result.stops.map(stop => ({ ...stop, companyName: selected[i].company }))) };
}
async function checkLookupRate(db, req, kind, now) {
    const raw=req.headers?.['x-vercel-forwarded-for'] || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    const ip=String(raw).split(',')[0].trim();
    const id=crypto.createHash('sha256').update(ip).digest('hex');
    const ref=db.collection('delivery_tracking_limits').doc(id);
    const window=Math.floor(now/60000),limit=kind==='number'?30:120;
    await db.runTransaction(async tx=>{
        const previous=(await tx.get(ref)).data()||{},entry=previous[kind];
        const count=entry?.window===window?entry.count:0;
        if(count>=limit)throw problem('조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.',429);
        tx.set(ref,{...previous,[kind]:{window,count:count+1},expireAt:new Date(now+3600000)});
    });
}
function createHandler(sdk = admin) {
    const numberHandler = require('../server/delivery-number.cjs').createHandler(sdk);
    const cache = new Map();
    const searchCache = new Map();
    return async function handler(req, res) {
        if (req.query?.operation === 'delivery-number') return numberHandler(req, res);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: '지원하지 않는 요청입니다.' });
        try {
            const lookupRequest = req.method === 'POST' && req.body?.action === 'lookup';
            let code = String(lookupRequest ? req.body.code || '' : req.query?.code || '');
            // Old preview URLs now resolve to the same real public search as /t.
            const publicSearch = ['', 'Ab3dE5fG', 'Ab3dE5fGh7Jk9LmN'].includes(code);
            if ((req.method === 'GET' || lookupRequest) && !publicSearch && !/^[A-Za-z0-9_-]{16}$/.test(code)) throw problem('올바른 배송조회 링크가 아닙니다.', 404);
            if (req.method === 'GET') throw problem('5자리 배송번호를 입력해 조회해 주세요.', 400);
            const lookup = lookupRequest ? String(req.body.lookup || '').trim() : '';
            if (lookupRequest && ((publicSearch && !lookup) || lookup.length > 150)) throw problem('5자리 배송번호를 입력해 주세요.');
            if (!sdk.apps.length) sdk.initializeApp({ credential: sdk.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
            }) });
            const db = sdk.firestore(), now = Date.now();
            if(lookupRequest)await checkLookupRate(db,req,publicSearch?'number':'link',now);
            if (lookupRequest && publicSearch) {
                if (!/^[A-Za-z0-9]{5}$/.test(lookup)) throw problem('5자리 배송번호를 입력해 주세요.');
                const reservation=(await db.collection('delivery_number_registry').doc('number_'+lookup).get()).data();
                if(reservation?.scope){
                    const seed={};let date=dayOf(now);
                    if(reservation.scope.startsWith('route:'))seed.owner=reservation.scope.slice(6);
                    else if(reservation.scope.startsWith('driver:')){
                        const driver=(await db.collection('licenses').doc(reservation.scope.slice(7)).get()).data();seed.owner=driver?.routeOwnerId;
                    }else if(reservation.scope.startsWith('dispatch:'))seed.company=reservation.scope.slice(9);
                    if(seed.owner){
                        const routes=await db.collection('routes').where('routeOwnerId','==',seed.owner).get();
                        const route=latestRoute(routes.docs.map(d=>({...d.data(),documentId:d.id})),seed.owner);
                        if(route)date=routeDay(route);
                    }
                    if(seed.owner||seed.company){
                        const index=await livePublications(db,date,now,lookup,false,seed);
                        if(index.publications.some(p=>p.stops.some(s=>s.deliveryNumber===lookup)))return res.status(200).json(lookupPublicData(index,lookup,now));
                    }
                }
                const numberLink=(await db.collection('delivery_tracking_numbers').doc(lookup).get()).data();
                if(!numberLink || numberLink.expiresAt<=now)throw problem('조회 가능한 배송이 없습니다. 배송번호를 확인해 주세요.',404);
                code=numberLink.code;
            }
            if (lookupRequest) {
                const cached = cache.get(code);
                const token = (await db.collection('delivery_tracking_tokens').doc(code).get()).data();
                if (!lookup && !token?.deliveryNumber) throw problem('전화번호 또는 주문번호를 입력해 주세요.');
                if (!token || token.expiresAt <= now) throw problem('배송조회 기간이 끝났거나 사용할 수 없는 링크입니다.', 404);
                const publication = (await db.collection('delivery_tracking_publications').doc(token.publication).get()).data();
                if (!publication || publication.expiresAt <= now) throw problem('배송조회 기간이 끝났습니다.', 404);
                const customerStops = publication.stops.filter(s => s.phone === token.phone);
                if (!token.deliveryNumber && phoneOf(lookup) !== token.phone && !customerStops.some(s => s.orders.some(order => order === lookup)))
                    throw problem('입력한 정보와 일치하는 배송이 없습니다. 주문할 때 등록한 전화번호 또는 주문번호를 확인해 주세요.', 404);
                if (cached && cached.until > now && cached.data.expiresAt > now) return res.status(200).json(cached.data);
                const keys = [...new Set(publication.stops.filter(s => s.phone === token.phone && (!token.deliveryNumber || s.deliveryNumber === token.deliveryNumber)).map(s => s.driver))];
                if (!keys.length) throw problem('배송 정보를 확인할 수 없습니다.', 404);
                const licenseDocs = await Promise.all(keys.map(key => db.collection('licenses').doc(key).get()));
                if (licenseDocs.some((d, i) => d.data()?.dispatchKey !== publication.dispatchKey || d.data()?.routeOwnerId !== publication.plans[keys[i]].owner))
                    throw problem('배송 담당 정보가 변경되었습니다. 배송업체에 확인해 주세요.', 404);
                const [snapshots, completions] = await Promise.all([
                    Promise.all(keys.map(key => db.collection('routes').where('routeOwnerId', '==', publication.plans[key].owner).get())),
                    ownerCompletions(db,[...new Set(keys.map(key => publication.plans[key].owner))],publication.date)
                ]);
                const completionTimes = {};
                for (const record of completions.sort((a,b)=>a.completedAt-b.completedAt)) {
                    const key = keys.find(key=>publication.plans[key].owner === record.routeOwnerId);
                    if (!key || record.destinationId == null) continue;
                    const completed = ['배송 완료','완료','직접 전달','사진 완료','문 앞','주방'].includes(record.tag) || /^기타\s*:/.test(record.tag || '');
                    (completionTimes[key] ||= {})[String(record.destinationId)] = completed ? record.completedAt : null;
                }
                const routes = snapshots.flatMap(s => s.docs.map(d => ({ ...d.data(), documentId: d.id })));
                const data = projectTracking({ ...publication, completionTimes }, token.phone, routes, token.deliveryNumber || '');
                if (cache.size >= 500) cache.delete(cache.keys().next().value);
                cache.set(code, { until: now + 30000, data });
                return res.status(200).json(data);
            }
            const bearer = /^Bearer (.+)$/.exec(req.headers?.authorization || '')?.[1];
            if (!bearer) throw problem('관제 로그인이 필요합니다.', 401);
            let identity;
            try { identity = await sdk.auth().verifyIdToken(bearer, true); }
            catch (_) { throw problem('로그인이 만료되었습니다.', 401); }
            const master = identity.role === 'MASTER' && identity.masterSmsVerified === true && identity.masterSessionExpiresAt > now / 1000;
            if (!master && identity.role !== 'DISPATCH') throw problem('관제 계정으로 로그인해 주세요.', 403);
            const body = req.body || {}, dispatchKey = master ? String(body.dispatchKey || '') : identity.uid;
            if (!dispatchKey || dispatchKey.length > 200 || dispatchKey.includes('/') || (!master && body.dispatchKey !== dispatchKey)) throw problem('관제 계정을 확인해 주세요.', 403);
            const date = String(body.date || ''), dayStart = Date.parse(date + 'T00:00:00+09:00');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dayStart) || dayOf(dayStart) !== date || Math.abs(dayStart - now) > 7 * DAY)
                throw problem('배송일은 오늘 기준 7일 이내로 선택해 주세요.');
            if (!Array.isArray(body.phones) || !body.phones.length || body.phones.length > 1000 || body.phones.some(p => !phoneOf(p))) throw problem('선택한 수신번호를 확인해 주세요.');
            const account = (await db.collection('licenses').doc(dispatchKey).get()).data();
            if (account?.type !== 'dispatch' || !isActive(account, dayOf(now), now)) throw problem('사용 중인 관제 이용권이 필요합니다.', 403);
            if (!master) assertDispatchSession(account, identity);
            const [licenseSnapshot, orderDoc] = await Promise.all([
                db.collection('licenses').where('dispatchKey', '==', dispatchKey).get(),
                db.collection('dispatch_orders').doc(`${date}_${dispatchKey}`).get()
            ]);
            const drivers = licenseSnapshot.docs.map(d => ({ ...d.data(), key: d.id })).filter(d => d.type !== 'dispatch' && d.routeOwnerId);
            const routeSnapshots = await Promise.all(drivers.map(d => db.collection('routes').where('routeOwnerId', '==', d.routeOwnerId).get()));
            const routes = routeSnapshots.flatMap(s => s.docs.map(d => ({ ...d.data(), documentId: d.id })));
            const sourceOrders = orderDoc.data()?.orders;
            const snapshot = snapshotFor(Array.isArray(sourceOrders) ? sourceOrders : [], drivers, routes, date);
            const phones = [...new Set(body.phones.map(phoneOf))];
            for (const phone of phones) {
                const stops = snapshot.stops.filter(s => s.phone === phone);
                if (!stops.length || stops.some(s => s.invalid)) throw problem('선택 대상 중 기사 경로가 없거나 번호·주소·배정을 확인할 배송지가 있습니다. 목록 새로고침 후 다시 선택해 주세요.', 409);
            }
            const publication = { ...snapshot, dispatchKey, date, company: clean(account.companyName || account.name) || '배송업체',
                createdAt: now, expiresAt: dayStart + 8 * DAY };
            if (Buffer.byteLength(JSON.stringify(publication)) > 800000) throw problem('배송 목록이 너무 큽니다. 관제 관리자에게 확인해 주세요.', 413);
            const secret = process.env.FIREBASE_PRIVATE_KEY;
            if (!secret) throw problem('배송조회 서버 설정을 확인해 주세요.', 503);
            const publicationId = crypto.createHash('sha256').update(JSON.stringify([dispatchKey, date, snapshot])).digest('hex');
            const publicationRef = db.collection('delivery_tracking_publications').doc(publicationId);
            // One shared immutable route snapshot keeps full route data out of each customer token.
            await db.runTransaction(async tx => { const old = await tx.get(publicationRef); if (!old.exists) tx.set(publicationRef, publication); });
            const links = phones.flatMap(phone => {
                const numbers=[...new Set(snapshot.stops.filter(s=>s.phone===phone).map(s=>s.deliveryNumber||''))];
                return numbers.map(deliveryNumber=>{
                    const parts=deliveryNumber?[publicationId,phone,deliveryNumber]:[publicationId,phone];
                    const code=crypto.createHmac('sha256',secret).update(JSON.stringify(parts)).digest().subarray(0,12).toString('base64url');
                    return {phone,code,...(deliveryNumber?{deliveryNumber}:{}),url:`https://mtsk.co.kr/t/${code}`};
                });
            });
            for (let offset = 0; offset < links.length; offset += 200) {
                const batch = db.batch();
                for (const link of links.slice(offset, offset + 200)) {
                    batch.set(db.collection('delivery_tracking_tokens').doc(link.code),
                        { publication: publicationId, phone: link.phone, ...(link.deliveryNumber?{deliveryNumber:link.deliveryNumber}:{}), expiresAt: publication.expiresAt });
                    if(link.deliveryNumber)batch.set(db.collection('delivery_tracking_numbers').doc(link.deliveryNumber),{code:link.code,expiresAt:publication.expiresAt});
                }
                await batch.commit();
            }
            return res.status(200).json({ links, expiresAt: publication.expiresAt });
        } catch (error) {
            if(error.status===429)res.setHeader('Retry-After','60');
            return res.status(error.status || 500).json({ error: error.status ? error.message : '배송 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.' });
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.checkLookupRate = checkLookupRate;
module.exports.snapshotFor = snapshotFor;
module.exports.projectTracking = projectTracking;
module.exports.lookupPublicData = lookupPublicData;

// Explicit one-time maintenance for existing records. Never called by customer requests.
function trackingKeysForDocument(collection, data) {
    if (collection === 'dispatch_orders') return trackingLookupKeys(data.date,data.orders);
    if (collection === 'completions') return Number.isFinite(data.completedAt)
        ? trackingLookupKeys(dayOf(data.completedAt),[data],data.routeOwnerId) : [];
    if (!Number.isFinite(data.updatedAt)) return [];
    return data.cleared ? [] : trackingLookupKeys(routeDay(data),[...(data.destinations || []),
        ...(data.routePlan?.deliveries || []).map(entry => entry.item)],data.routeOwnerId);
}
async function reindexTracking(db) {
    const counts = {};
    for (const name of ['routes','dispatch_orders','completions']) {
        const snapshot = await db.collection(name).get(); let changed = 0;
        for (let offset = 0; offset < snapshot.docs.length; offset += 200) {
            const batch = db.batch(); let writes = 0;
            for (const d of snapshot.docs.slice(offset,offset + 200)) {
                const data = d.data(), keys = trackingKeysForDocument(name,data);
                if (JSON.stringify(data.trackingLookupKeys) === JSON.stringify(keys)) continue;
                batch.update(d.ref,{trackingLookupKeys:keys}); writes++; changed++;
            }
            if (writes) await batch.commit();
        }
        counts[name] = changed;
    }
    return counts;
}
module.exports.trackingLookupKeys = trackingLookupKeys;
module.exports.trackingKeysForDocument = trackingKeysForDocument;
module.exports.reindexTracking = reindexTracking;
if (require.main === module && process.argv.includes('--reindex-tracking')) {
    if (!admin.apps.length) admin.initializeApp({credential:admin.credential.cert({
        projectId:process.env.FIREBASE_PROJECT_ID,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n')
    })});
    reindexTracking(admin.firestore()).then(counts => console.log(counts)).catch(error => {console.error(error.message);process.exitCode = 1;});
}
