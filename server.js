// Start-up wrapper: registers the plan-sync routes, then loads the existing index.js unchanged.
// It hooks app.listen so the new routes are added right before the server starts.
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const planRoutes = require('./plan_routes');

const originalListen = express.application.listen;
express.application.listen = function (...args) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  planRoutes(this, supabase);
  return originalListen.apply(this, args);
};

require('./index.js');
