'use strict';
// Run:  npm i express @watchtowerobservability/node && WT_INGEST_KEY=... WT_SERVICE=demo node server.js
const express = require('express');
const wt = require('@watchtowerobservability/node');
const { requestHandler, errorHandler } = require('@watchtowerobservability/node/express');

wt.init({}); // key, endpoint, service, environment and release come from WT_* env vars

const app = express();
app.use(requestHandler());
app.get('/', (_req, res) => { wt.log('info', 'hello'); res.send('ok'); });
app.get('/boom', () => { throw new Error('test error from the example'); });
app.use(errorHandler());
app.listen(3000, () => console.log('http://localhost:3000  (try /boom)'));
