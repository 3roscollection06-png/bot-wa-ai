const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const FIREBASE_REST_URL = "https://target21hari-default-rtdb.asia-southeast1.firebasedatabase.app";
const FONNTE_API_TOKEN = "tMj43cRJ5E3kHLFowY61";

// Fungsi helper kirim pesan balasan WA via Fonnte
async function replyWhatsApp(targetWa, message) {
  try {
    const formData = new URLSearchParams();
    formData.append('target', targetWa);
    formData.append('message', message);
    formData.append('countryCode', '62');

    await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        'Authorization': FONNTE_API_TOKEN,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData
    });
  } catch (err) {
    console.error("Gagal mengirim balasan WA:", err);
  }
}

// Endpoint Webhook yang didaftarkan ke Fonnte
router.post('/', async (req, res) => {
  try {
    const incoming = req.body;
    // Fonnte mengirim parameter: sender (nomor pengirim), message (pesan teks)
    const senderWa = incoming.sender || incoming.from;
    const messageText = (incoming.message || '').trim();

    if (!senderWa || !messageText) {
      return res.status(400).json({ status: false, reason: 'Pesan atau pengirim kosong' });
    }

    console.log(`📥 [PESAN MASUK DARI WA] ${senderWa}: ${messageText}`);

    // 1. Cari pengguna di Firebase berdasarkan nomor WhatsApp
    const usersRes = await fetch(`${FIREBASE_REST_URL}/users.json`);
    const usersData = await usersRes.json();

    let matchedUserEmailKey = null;
    let matchedUserData = null;

    if (usersData) {
      for (const key of Object.keys(usersData)) {
        const u = usersData[key];
        if (u && u.whatsapp) {
          // Normalisasi nomor untuk pencocokan
          const cleanUserWa = u.whatsapp.replace(/[^0-9]/g, '');
          const cleanSender = senderWa.replace(/[^0-9]/g, '');
          if (cleanSender.endsWith(cleanUserWa) || cleanUserWa.endsWith(cleanSender)) {
            matchedUserEmailKey = key;
            matchedUserData = u;
            break;
          }
        }
      }
    }

    if (!matchedUserData) {
      await replyWhatsApp(senderWa, "⚠️ Maaf, nomor WhatsApp Anda belum terdaftar di aplikasi Focus Est 2026. Silakan daftar terlebih dahulu di aplikasi.");
      return res.status(200).json({ status: true, info: 'User not found' });
    }

    // 2. Parser AI Sederhana untuk Perintah Duit Tracker
    // Contoh format pesan: "masuk 100000 gaji bulanan" atau "keluar 25000 beli makan siang"
    const lowerMsg = messageText.toLowerCase();
    let type = null;
    if (lowerMsg.includes('masuk') || lowerMsg.includes('terima') || lowerMsg.includes('pendapatan')) {
      type = 'income';
    } else if (lowerMsg.includes('keluar') || lowerMsg.includes('beli') || lowerMsg.includes('bayar') || lowerMsg.includes('expense')) {
      type = 'expense';
    }

    if (type) {
      // Ekstrak angka / nominal uang dari teks pesan
      const numbers = messageText.replace(/[^0-9]/g, '');
      const amount = parseFloat(numbers) || 0;

      if (amount > 0) {
        // Ambil sisa teks sebagai keterangan
        let desc = messageText.replace(/(masuk|keluar|beli|bayar|terima|pendapatan|rp|\.|,|idr)/gi, '').trim();
        // Bersihkan angka dari string deskripsi
        desc = desc.replace(/[0-9]/g, '').trim() || "Transaksi via Bot WA AI";

        const newTx = {
          id: 'dt_' + Date.now(),
          type: type,
          amount: amount,
          date: new Date().toISOString().split('T')[0],
          desc: desc
        };

        // Ambil data user_data saat ini
        const dataRes = await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`);
        let currentAppData = await dataRes.json() || {};
        
        if (!currentAppData.duitTransactions) {
          currentAppData.duitTransactions = [];
        }

        // Masukkan transaksi baru ke paling depan array
        currentAppData.duitTransactions.unshift(newTx);

        // Simpan kembali ke Firebase Realtime Database
        await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentAppData)
        });

        const formatRupiah = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(num);
        const replyText = `✅ *BERHASIL DICATAT OLEH BOT AI!*\n\nJenis: ${type === 'income' ? '💰 Pemasukan (+)' : '💸 Pengeluaran (-)'}\nNominal: *${formatRupiah(amount)}*\nKeterangan: ${desc}\nTanggal: ${newTx.date}\n\n_Data telah disinkronkan otomatis ke Duit Tracker akun Anda._`;
        
        await replyWhatsApp(senderWa, replyText);
        return res.status(200).json({ status: true, message: 'Transaction recorded successfully' });
      }
    }

    // Jika pesan berupa teks biasa atau sapaan
    await replyWhatsApp(senderWa, `Halo *${matchedUserData.name}*! Bot WA AI Focus Est 2026 menerima pesan Anda. \n\nKetik format pencatatan keuangan:\n• "Masuk 50000 jual produk"\n• "Keluar 15000 beli bensin"`);
    return res.status(200).json({ status: true, message: 'General message processed' });

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).json({ status: false, error: error.message });
  }
});

module.exports = router;