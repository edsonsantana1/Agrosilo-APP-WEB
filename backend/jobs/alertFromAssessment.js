// backend/jobs/alertFromAssessment.js
const { persistAlertsFromAssessment } = require('../services/alertService');
const Silo = require('../models/silo');

async function run() {
  const silos = await Silo.find({}).select('_id user').lean();
  for (const s of silos) {
    try {
      await persistAlertsFromAssessment(s.user, s._id);
    } catch (e) {
      console.error('[alerts][assessment]', s._id, e.message);
    }
  }
}

module.exports = { run };
