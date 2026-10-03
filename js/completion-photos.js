// Blobs stay out of localStorage. Resolve writes only after the IndexedDB commit.
let photoDatabase;
function openPhotoDatabase() {
    if (!photoDatabase) photoDatabase = new Promise((resolve, reject) => {
        const request = indexedDB.open('deliveryPro_completion_photos', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('photos');
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('사진 저장소가 다른 창에서 사용 중입니다.'));
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); photoDatabase = null; };
            resolve(db);
        };
    }).catch(error => { photoDatabase = null; throw error; });
    return photoDatabase;
}

async function photoOperation(mode, operation) {
    const db = await openPhotoDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('photos', mode);
        const request = operation(transaction.objectStore('photos'));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error || new Error('사진 저장 실패'));
        transaction.onerror = () => reject(transaction.error || new Error('사진 저장 실패'));
    });
}

export const completionPhotos = {
    put(id, blob) { return photoOperation('readwrite', store => store.put(blob, id)); },
    get(id) { return photoOperation('readonly', store => store.get(id)); },
    remove(id) { return photoOperation('readwrite', store => store.delete(id)); }
};
