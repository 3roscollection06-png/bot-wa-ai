const express = require('express');
const bodyParser = require('body-parser');
const webhookRouter = require('./webhook');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Gunakan webhook router
app.use('/webhook', webhookRouter);

app.get('/', (req, res) => {
  sendResponse(res, 200, { status: 'OK', message: 'Server Bot WA AI Focus Est 2026 Berjalan Aktif!' });
});

app.listen(PORT, () => {
  console.log(`Server webhook berjalan di port ${PORT}`);
});