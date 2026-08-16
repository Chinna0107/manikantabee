const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  'http://localhost:5173',
  'https://manikanta-two.vercel.app',
  
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

const path = require('path');

app.use('/api/general', require('./routes/general'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/upload', require('./routes/upload'));
app.use('/api/delivery', require('./routes/delivery'));

app.use((req, res) => res.status(404).json({ error: 'API route not found' }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
