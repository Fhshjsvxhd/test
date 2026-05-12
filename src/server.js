'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
require('./db');

const trackerRoutes = require('./tracker');
const apiRoutes = require('./api');

const app = express();
if (config.trustProxy) app.set('trust proxy', true);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// simple cookie parse (avoid extra dep)
app.use((req, res, next) => {
  const h = req.headers.cookie || '';
  const jar = {};
  h.split(';').forEach(p => {
    const [k, ...v] = p.trim().split('=');
    if (k) jar[k] = decodeURIComponent(v.join('=') || '');
  });
  req.cookies = jar;
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// tracker first (domain-based, /f/:slug, /t/:slug, /px)
app.use('/', trackerRoutes);

// admin API
app.use('/api', apiRoutes);

// dashboard + landing
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'internal' });
});

app.listen(config.port, () => {
  console.log(`Cloakly running on http://localhost:${config.port}`);
  console.log(`   Dashboard: /admin   (token: ${config.adminToken})`);
});
