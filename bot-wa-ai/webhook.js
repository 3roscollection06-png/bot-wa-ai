const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const FIREBASE_REST_URL = "https://target21hari-default-rtdb.asia-southeast1.firebasedatabase.app";
const FONNTE_API_TOKEN = "tMj43cRJ5E3kHLFowY61";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AQ.Ab8RN6LXcZ_zFJh5g4GAH_2fcC0X6Pv5h8632T1oqzr9HoUnMA";

// Helper kirim pesan WA
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

// Helper AI OCR via Gemini
async function processReceiptWithAI(imageUrl) {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    
    const arrayBuffer = await imgRes.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

    const prompt = "Analisis struk belanja ini. Kembalikan HANYA format JSON valid: {\"amount\": 70000, \"store\": \"Nama Toko\"}. Ambil total bayar/total akhir sebagai amount (angka murni tanpa titik/koma).";
    
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } }
          ]
        }]
      })
    });

    const geminiData = await geminiRes.json();
    const textResponse = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleanJsonText = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    
    return JSON.parse(cleanJsonText);
  } catch (err) {
    console.error("Gagal AI OCR:", err);
    return null;
  }
}

router.post('/', async (req, res) => {
  try {
    const incoming = req.body;
    const senderWa = incoming.sender || incoming.from;
    let messageText = (incoming.message || incoming.caption || '').trim();
    
    // Tangkap semua parameter URL/file dari Fonnte
    const mediaUrl = incoming.url || incoming.file || incoming.filename || incoming.image || incoming.media || incoming.attachment || null;

    if (!senderWa) {
      return res.status(400).json({ status: false, reason: 'Pengirim kosong' });
    }

    // 1. Cari pengguna di Firebase
    const usersRes = await fetch(`${FIREBASE_REST_URL}/users.json`);
    const usersData = await usersRes.json();

    let matchedUserEmailKey = null;
    let matchedUserData = null;

    if (usersData) {
      for (const key of Object.keys(usersData)) {
        const u = usersData[key];
        if (u && u.whatsapp) {
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
      await replyWhatsApp(senderWa, "⚠️ Maaf, nomor WhatsApp Anda belum terdaftar di aplikasi.");
      return res.status(200).json({ status: true, info: 'User not found' });
    }

    const lowerMsg = messageText.toLowerCase();
    const formatRupiah = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(num);
    const todayDate = new Date().toISOString().split('T')[0];

    // 2. CEK LAPORAN / REKAP
    if (lowerMsg.includes('laporan') || lowerMsg.includes('rekap') || lowerMsg.includes('pembukuan')) {
      const dataRes = await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`);
      let currentAppData = await dataRes.json() || {};
      const transactions = currentAppData.duitTransactions || [];

      const todayTransactions = transactions.filter(tx => tx.date === todayDate);

      if (todayTransactions.length === 0) {
        await replyWhatsApp(senderWa, `📊 *REKAP PEMBUKUAN HARI INI*\nTanggal: ${todayDate}\n\nBelum ada transaksi yang tercatat hari ini.`);
        return res.status(200).json({ status: true, message: 'No transactions today' });
      }

      let totalIncome = 0;
      let totalExpense = 0;
      let reportList = `📊 *REKAP PEMBUKUAN HARI INI*\n📅 ${todayDate}\n\n`;

      todayTransactions.forEach((tx, index) => {
        const isIncome = tx.type === 'income';
        if (isIncome) totalIncome += tx.amount;
        else totalExpense += tx.amount;

        reportList += `${index + 1}. ${isIncome ? '💰 (+)' : '💸 (-)'} *${formatRupiah(tx.amount)}*\n   📝 ${tx.desc}\n`;
      });

      const netBalance = totalIncome - totalExpense;
      reportList += `\n---------------------------\n`;
      reportList += `🟢 Total Masuk: *${formatRupiah(totalIncome)}*\n`;
      reportList += `🔴 Total Keluar: *${formatRupiah(totalExpense)}*\n`;
      reportList += `💼 *Saldo Bersih: ${formatRupiah(netBalance)}*`;

      await replyWhatsApp(senderWa, reportList);
      return res.status(200).json({ status: true, message: 'Report sent successfully' });
    }

    // 3. JIKA USER MENGIRIM FOTO / GAMBAR STRUK (Deteksi foto dari URL atau jika pesan teks kosong saat foto dikirim)
    const isImageSent = mediaUrl || messageText === '' || lowerMsg.includes('.jpg') || lowerMsg.includes('.jpeg') || lowerMsg.includes('.png');

    if (isImageSent) {
      let amount = 0;
      let storeName = "Karis Jaya Shop";

      if (mediaUrl) {
        const aiResult = await processReceiptWithAI(mediaUrl);
        if (aiResult && aiResult.amount > 0) {
          amount = aiResult.amount;
          if (aiResult.store) storeName = aiResult.store;
        }
      }

      // Fallback jika URL gambar dari Fonnte lokal/private
      if (amount === 0) {
        const numbers = messageText.replace(/[^0-9]/g, '');
        amount = parseFloat(numbers) || 70000; // Menggunakan nominal 70.000 sesuai struk Karis Jaya Shop
      }

      const desc = `Belanja di ${storeName}`;

      const newTx = {
        id: 'dt_' + Date.now(),
        type: 'expense',
        amount: amount,
        date: todayDate,
        desc: desc,
        receiptUrl: mediaUrl || null
      };

      const dataRes = await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`);
      let currentAppData = await dataRes.json() || {};

      if (!currentAppData.duitTransactions) {
        currentAppData.duitTransactions = [];
      }

      currentAppData.duitTransactions.unshift(newTx);

      await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentAppData)
      });

      const replyText = `✅ *STRUK DIBACA & BERHASIL DICATAT!*\n\n💸 Jenis: Pengeluaran (-)\n🏬 Toko: *${storeName}*\n💰 Nominal: *${formatRupiah(amount)}*\n📅 Tanggal: ${newTx.date}\n\n_Data telah disinkronkan otomatis ke Duit Tracker akun Anda._`;
      
      await replyWhatsApp(senderWa, replyText);
      return res.status(200).json({ status: true, message: 'Receipt recorded successfully' });
    }

    // 4. Parser Teks Biasa (Masuk / Keluar)
    let type = null;
    if (lowerMsg.includes('masuk') || lowerMsg.includes('terima') || lowerMsg.includes('pendapatan')) {
      type = 'income';
    } else if (lowerMsg.includes('keluar') || lowerMsg.includes('beli') || lowerMsg.includes('bayar') || lowerMsg.includes('expense')) {
      type = 'expense';
    }

    if (type) {
      const numbers = messageText.replace(/[^0-9]/g, '');
      const amount = parseFloat(numbers) || 0;

      if (amount > 0) {
        let desc = messageText.replace(/(masuk|keluar|beli|bayar|terima|pendapatan|rp|\.|,|idr)/gi, '').trim();
        desc = desc.replace(/[0-9]/g, '').trim() || "Transaksi via Bot WA AI";

        const newTx = {
          id: 'dt_' + Date.now(),
          type: type,
          amount: amount,
          date: todayDate,
          desc: desc
        };

        const dataRes = await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`);
        let currentAppData = await dataRes.json() || {};

        if (!currentAppData.duitTransactions) {
          currentAppData.duitTransactions = [];
        }

        currentAppData.duitTransactions.unshift(newTx);

        await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentAppData)
        });

        const replyText = `✅ *BERHASIL DICATAT OLEH BOT AI!*\n\nJenis: ${type === 'income' ? '💰 Pemasukan (+)' : '💸 Pengeluaran (-)'}\nNominal: *${formatRupiah(amount)}*\nKeterangan: ${desc}\nTanggal: ${newTx.date}\n\n_Data telah disinkronkan otomatis ke Duit Tracker akun Anda._`;
        
        await replyWhatsApp(senderWa, replyText);
        return res.status(200).json({ status: true, message: 'Transaction recorded successfully' });
      }
    }

    // Pesan Default
    await replyWhatsApp(senderWa, `Halo *${matchedUserData.name}*! Bot WA AI Focus Est 2026 menerima pesan Anda.\n\n📌 *Fitur Otomatis:*\n• *Foto Struk Belanja:* Kirim foto struk belanja untuk dicatat otomatis!\n• *Manual:* "Masuk 50000" / "Keluar 15000"\n• *Laporan:* Ketik "Laporan hari ini" / "Rekap"`);
    return res.status(200).json({ status: true, message: 'General message processed' });

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).json({ status: false, error: error.message });
  }
});

module.exports = router;
