import {
  cancelMembership,
  getMembershipAnalytics,
  getUserMembership,
  listMembershipBilling,
  pauseMembership,
  resumeMembership,
} from '../services/membershipLifecycle.service.js';
import { createSecurePaymentSession } from '../services/securePayments.service.js';

export async function getCurrentMembership(req, res) {
  try {
    const data = await getUserMembership(req.uid);
    return res.json({ ok: true, success: true, data });
  } catch (error) {
    console.error('[memberships] current error:', error.message);
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
}

export async function subscribeMembership(req, res) {
  try {
    const {
      planId,
      countryCode = 'US',
      customerEmail = '',
      customerName = 'Member',
    } = req.body || {};
    if (!planId) return res.status(400).json({ ok: false, success: false, error: 'planId is required' });
    const checkout = await createSecurePaymentSession({
      userId: req.uid,
      productType: 'membership',
      productId: planId,
      countryCode,
      customerEmail,
      customerName,
      req,
    });
    return res.json({ ok: true, success: true, ...checkout });
  } catch (error) {
    const status = /unreachable|timed out/i.test(error.message) ? 503 : 500;
    return res.status(status).json({ ok: false, success: false, error: error.message });
  }
}

export async function renewMembership(req, res) {
  try {
    const current = await getUserMembership(req.uid);
    const {
      planId = current?.planId || current?.plan,
      countryCode = 'US',
      customerEmail = '',
      customerName = 'Member',
    } = req.body || {};

    if (!planId || planId === 'basic') {
      return res.status(400).json({ ok: false, success: false, error: 'No active membership plan to renew.' });
    }

    const checkout = await createSecurePaymentSession({
      userId: req.uid,
      productType: 'membership',
      productId: planId,
      countryCode,
      customerEmail,
      customerName,
      req,
    });
    return res.json({ ok: true, success: true, ...checkout });
  } catch (error) {
    const status = /unreachable|timed out/i.test(error.message) ? 503 : 500;
    return res.status(status).json({ ok: false, success: false, error: error.message });
  }
}

export async function cancelCurrentMembership(req, res) {
  try {
    const result = await cancelMembership(req.uid);
    return res.json({ ok: true, success: true, data: result });
  } catch (error) {
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
}

export async function pauseCurrentMembership(req, res) {
  try {
    const result = await pauseMembership(req.uid);
    return res.json({ ok: true, success: true, data: result });
  } catch (error) {
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
}

export async function resumeCurrentMembership(req, res) {
  try {
    const result = await resumeMembership(req.uid);
    return res.json({ ok: true, success: true, data: result });
  } catch (error) {
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
}

export async function getMembershipBillingHistory(req, res) {
  try {
    const data = await listMembershipBilling(req.uid, req.query);
    return res.json({ ok: true, success: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, success: false, error: error.message });
  }
}

export async function getAdminMembershipAnalytics(_req, res) {
  try {
    const analytics = await getMembershipAnalytics();
    return res.json({ success: true, analytics });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
