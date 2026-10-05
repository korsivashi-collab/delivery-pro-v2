// js/admin-api.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyBZKERmiPis4PCVDSYg0SSRTWV7L3z_5tw",
    authDomain: "delivery-pro-dd272.firebaseapp.com",
    projectId: "delivery-pro-dd272",
    storageBucket: "delivery-pro-dd272.firebasestorage.app",
    messagingSenderId: "329406776647",
    appId: "1:329406776647:web:62b32568328dd1eecab862"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

export function generateSecureKey() {
    const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    let p1 = "", p2 = "";
    for (let i = 0; i < 4; i++) {
        p1 += chars.charAt(Math.floor(Math.random() * chars.length));
        p2 += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `${p1}-${p2}`;
}