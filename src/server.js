'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
require('./db'); // init schema

const trackerRoutes = require('./tracker/routes');
const apiRoutes = require('./api/routes');

const app = express();

if (config.trustProxy) app.set('trust proxy', true);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Tracker routes first (so /t/:slug, /go/, /px/, /postback aren't shadowed)
app.use('/', trackerRoutes);

// Admin API
app.use('/api', apiRoutes);

// Static: dashboard + public landing page
app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Fallback for /admin routes
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

app.listen(config.port, () => {
  console.log(`AdTrack running on http://localhost:${config.port}`);
  console.log(`   Dashboard: http://localhost:${config.port}/admin  (token: ${config.adminToken})`);
  console.log(`   Demo:      http://localhost:${config.port}/t/demo`);
});
