import { Router } from 'express';
import { keepAliveAbuseLimiter, verifyQstashSignature } from '../middleware/qstashSignature.js';
import { scanWebsiteVerification } from '../services/publisherVerification.service.js';
import { updatePartnerFraudScore } from '../services/publisherFraud.service.js';
import { supabase } from '../config/supabase.js';

const router = Router();

router.use(keepAliveAbuseLimiter);
router.use(verifyQstashSignature);

router.post('/verify', async (req, res) => {
  try {
    const websiteId = req.body?.websiteId;
    if (!websiteId) return res.status(400).json({ success: false, message: 'websiteId required' });
    const result = await scanWebsiteVerification(websiteId);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
});

router.post('/rollup', async (req, res) => {
  try {
    const since = new Date(Date.now() - 86400000).toISOString();
    const { data: partners } = await supabase.from('publisher_partners').select('id').eq('status', 'active');
    const results = [];
    for (const p of partners || []) {
      const { data: events } = await supabase
        .from('publisher_ad_events')
        .select('revenue_usd, is_valid')
        .eq('partner_id', p.id)
        .gte('created_at', since);
      const valid = (events || []).filter((e) => e.is_valid);
      const dayRevenue = valid.reduce((s, e) => s + Number(e.revenue_usd || 0), 0);
      const impressions = valid.length;
      results.push({ partnerId: p.id, dayRevenue, impressions });
    }
    return res.json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
});

router.post('/fraud-rescore', async (req, res) => {
  try {
    const partnerId = req.body?.partnerId;
    if (partnerId) {
      const score = await updatePartnerFraudScore(partnerId);
      return res.json({ success: true, partnerId, fraudScore: score });
    }
    const { data: partners } = await supabase.from('publisher_partners').select('id').eq('status', 'active');
    const results = [];
    for (const p of partners || []) {
      results.push({ id: p.id, score: await updatePartnerFraudScore(p.id) });
    }
    return res.json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || 'Failed' });
  }
});

export default router;
