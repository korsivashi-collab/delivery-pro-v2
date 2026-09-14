// js/utils.js

// 0. 스마트폰 사진의 EXIF(메타데이터) 방향 정보를 읽어내는 헬퍼 함수
function getExifOrientation(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function(e) {
            const view = new DataView(e.target.result);
            if (view.getUint16(0, false) != 0xFFD8) return resolve(1);
            const length = view.byteLength;
            let offset = 2;
            while (offset < length) {
                if (offset + 2 >= length) break;
                const marker = view.getUint16(offset, false);
                offset += 2;
                if (marker == 0xFFE1) {
                    if (view.getUint32(offset += 2, false) != 0x45786966) return resolve(1);
                    const little = view.getUint16(offset += 6, false) == 0x4949;
                    offset += view.getUint32(offset + 4, little);
                    const tags = view.getUint16(offset, little);
                    offset += 2;
                    for (let i = 0; i < tags; i++) {
                        if (view.getUint16(offset + (i * 12), little) == 0x0112) {
                            return resolve(view.getUint16(offset + (i * 12) + 8, little));
                        }
                    }
                }
                else if ((marker & 0xFF00) != 0xFF00) break;
                else offset += view.getUint16(offset, false);
            }
            return resolve(1);
        };
        reader.readAsArrayBuffer(file);
    });
}

// 1. 클라이언트단 사진 안전 압축 및 EXIF 회전/흑백/대비 전처리 (OCR 인식률 대폭 향상)
export async function toBase64_SafeCompress(file) {
    // 파일의 원본 회전 상태 파악
    const orientation = await getExifOrientation(file);

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image(); 
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = 1600; 
                let width = img.width, height = img.height;
                
                // 비율에 맞게 리사이징
                if (width > height) { 
                    if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; } 
                } else { 
                    if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; } 
                }

                const ctx = canvas.getContext('2d'); 
                
                // EXIF 방향 정보에 따라 캔버스의 실제 가로/세로 길이를 뒤집어 줌 (중요)
                if (orientation >= 5 && orientation <= 8) {
                    canvas.width = height;
                    canvas.height = width;
                } else {
                    canvas.width = width;
                    canvas.height = height;
                }

                // 사진을 올바른 각도로 캔버스에 회전시켜 그리기
                switch (orientation) {
                    case 2: ctx.transform(-1, 0, 0, 1, width, 0); break;
                    case 3: ctx.transform(-1, 0, 0, -1, width, height); break;
                    case 4: ctx.transform(1, 0, 0, -1, 0, height); break;
                    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
                    case 6: ctx.transform(0, 1, -1, 0, height, 0); break; // 아이폰 세로 사진 90도 회전 보정
                    case 7: ctx.transform(0, -1, -1, 0, height, width); break;
                    case 8: ctx.transform(0, -1, 1, 0, 0, width); break;
                    default: break;
                }
                
                // 흑백 및 대비(Contrast)를 높여 텍스트 경계선을 선명하게 전처리 (OCR 정확도 상승)
                ctx.filter = 'grayscale(100%) contrast(150%)'; 
                
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.85)); // 용량 최적화 (품질 85%)
            };
            img.onerror = (e) => reject(e);
        };
        reader.onerror = error => reject(error);
    });
}

// 2. OCR 텍스트에서 전화번호 추출 로직
export function extractPhoneLogic(text) {
    if (!text) return null;
    let candidates = [];
    const tokens = text.split(/[\s\n,;|]+/);
    for (let token of tokens) {
        let digits = token.replace(/[^\d]/g, '');
        if (digits.length >= 8 && digits.length <= 12) candidates.push(digits);
    }
    const phoneRegex = /(010|050\d|070|0[2-9][0-9]?|1[5-9]\d{2})[\s\-\.]*(\d{3,4})[\s\-\.]*(\d{4})/g;
    const rawMatches = [...text.matchAll(phoneRegex)];
    for (let m of rawMatches) candidates.push(m[0].replace(/[^\d]/g, ''));
    
    const repRegex = /(1[5-9]\d{2})[\s\-\.]*(\d{4})/g;
    const repMatches = [...text.matchAll(repRegex)];
    for (let m of repMatches) candidates.push(m[0].replace(/[^\d]/g, ''));
    
    candidates = [...new Set(candidates)];
    
    let bestPhone = null; 
    let highestScore = -1;
    for (let num of candidates) {
        let score = 0;
        let is010 = num.startsWith('010') && (num.length === 10 || num.length === 11);
        let is050 = num.startsWith('050') && (num.length === 11 || num.length === 12);
        let is070 = num.startsWith('070') && (num.length === 10 || num.length === 11);
        let isRep = /^1[5-9]\d{6}$/.test(num); 
        let is02 = num.startsWith('02') && (num.length === 9 || num.length === 10);
        let isLocal = /^0[3-9]\d/.test(num) && (num.length === 10 || num.length === 11);
        
        if (is010) score += 100; 
        else if (is050) score += 90; 
        else if (is070) score += 80;
        else if (isRep) score += 70; 
        else if (is02 || isLocal) score += 60; 
        else score -= 100; 
        
        if (/(\d)\1{4,}/.test(num)) score -= 50;
        if (score > highestScore && score > 0) { 
            highestScore = score; 
            bestPhone = num; 
        }
    }
    
    if (bestPhone) {
        let p = bestPhone;
        if (p.startsWith('010') || p.startsWith('070') || /^0[3-9]\d/.test(p)) {
            if (p.length === 11) return p.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
            if (p.length === 10) return p.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
        }
        if (p.startsWith('050')) {
            if (p.length === 12) return p.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3');
            if (p.length === 11) return p.replace(/(\d{4})(\d{3})(\d{4})/, '$1-$2-$3');
        }
        if (/^1[5-9]\d{6}$/.test(p)) return p.replace(/(\d{4})(\d{4})/, '$1-$2');
        if (p.startsWith('02')) {
            if (p.length === 9) return p.replace(/(\d{2})(\d{3})(\d{4})/, '$1-$2-$3');
            if (p.length === 10) return p.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
        }
        return p;
    }
    return null;
}

// 3. OCR 텍스트에서 주소 추출 로직
export function extractAddressLogic(text) {
    if (!text || typeof text !== 'string') return null;
    try {
        let flatText = text.replace(/\n/g, ' ').replace(/\([^)]+\)/g, ' ').replace(/\s+/g, ' ');
        let regex1 = /(([가-힣]+(?:시|도))?\s*[가-힣]+(?:시|군|구)\s+[가-힣a-zA-Z0-9\s]+(?:동|읍|면|리|대로|로|길)\s*\d+(?:-\d+)?)/g;
        let matches1 = [...flatText.matchAll(regex1)];
        if (matches1 && matches1.length > 0) return matches1[matches1.length - 1][0].trim();
        
        let regex2 = /([가-힣a-zA-Z0-9]+(?:동|읍|면|리|대로|로|길)\s*\d+(?:-\d+)?)/g;
        let matches2 = [...flatText.matchAll(regex2)];
        if (matches2 && matches2.length > 0) return matches2[matches2.length - 1][0].trim();
    } catch (e) {} 
    return null;
}