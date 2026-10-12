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

    const lowerMsg = messageText.toLowerCase();
    const formatRupiah = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(num);
    const todayDate = new Date().toISOString().split('T')[0];

    // 2. CEK APAKAH USER MEMINTA LAPORAN / REKAP
    if (lowerMsg.includes('laporan') || lowerMsg.includes('rekap') || lowerMsg.includes('pembukuan')) {
      // Ambil data transaksi user
      const dataRes = await fetch(`${FIREBASE_REST_URL}/user_data/${matchedUserEmailKey}.json`);
      let currentAppData = await dataRes.json() || {};
      const transactions = currentAppData.duitTransactions || [];

      // Filter transaksi hari ini
      const todayTransactions = transactions.filter(tx => tx.date === todayDate);

      if (todayTransactions.length === 0) {
        await replyWhatsApp(senderWa, `📊 *REKAP PEMBUKUAN HARI INI*\nTanggal: ${todayDate}\n\nBelum ada transaksi yang tercatat hari ini.\n\nKetik:\n• *Masuk [nominal] [ket]*\n• *Keluar [nominal] [ket]*`);
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

    // 3. Parser Pencatatan Keuangan (Masuk / Keluar)
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

    // Jika pesan berupa teks biasa atau sapaan selain perintah laporan/catat
    await replyWhatsApp(senderWa, `Halo *${matchedUserData.name}*! Bot WA AI Focus Est 2026 menerima pesan Anda.\n\n📌 *Perintah yang tersedia:*\n1. Catat Transaksi:\n   • "Masuk 50000 jual produk"\n   • "Keluar 15000 beli bensin"\n2. Lihat Laporan:\n   • "Laporan hari ini" / "Rekap"`);
    return res.status(200).json({ status: true, message: 'General message processed' });

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).json({ status: false, error: error.message });
  }
});

module.exports = router;
