// ============================================================
// LOYALTY MD Session Generator — Configuration
// ============================================================
// Set your values here or use environment variables.
// Environment variables always take priority over values below.
// ============================================================

export default {
  // MongoDB Atlas connection string
  // Example: 'mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority'
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://goodlucknosakhare9_db_user:loyalty@cluster0.gei0orj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',

  // Bot name (shown in health check)
  BOT_NAME: 'LOYALTY MD',
};
