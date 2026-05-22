const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function paystackHeaders() {
  const key = process.env.PAYSTACK_SECRET_KEY || '';
  if (!key) {
    const err = new Error('Paystack secret key is not configured.');
    err.code = 'PAYSTACK_NOT_CONFIGURED';
    throw err;
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function paystackPost(path, body) {
  const response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    method: 'POST',
    headers: paystackHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.PAYSTACK_TIMEOUT_MS || 15000)),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === false) {
    const err = new Error(payload.message || `Paystack request failed with HTTP ${response.status}`);
    err.code = 'PAYSTACK_REQUEST_FAILED';
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

export async function createTransferRecipient({ name, accountNumber, bankCode }) {
  if (!name || !accountNumber || !bankCode) {
    const err = new Error('Creator bank name, account number, and bank code are required for Paystack transfer.');
    err.code = 'INVALID_TRANSFER_RECIPIENT';
    throw err;
  }

  const payload = await paystackPost('/transferrecipient', {
    type: 'nuban',
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: 'NGN',
  });

  const recipientCode = payload?.data?.recipient_code;
  if (!recipientCode) {
    const err = new Error('Paystack did not return a transfer recipient code.');
    err.code = 'PAYSTACK_RECIPIENT_MISSING';
    err.payload = payload;
    throw err;
  }

  return {
    recipientCode,
    raw: payload,
  };
}

export async function initiateTransfer({ amountNgn, recipientCode, reference, reason }) {
  const amount = Number(amountNgn);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('A valid NGN payout amount is required.');
    err.code = 'INVALID_TRANSFER_AMOUNT';
    throw err;
  }

  const payload = await paystackPost('/transfer', {
    source: 'balance',
    amount: Math.round(amount * 100),
    recipient: recipientCode,
    reason: reason || 'Creator payout',
    reference,
  });

  return {
    transferCode: payload?.data?.transfer_code || null,
    reference: payload?.data?.reference || reference,
    status: payload?.data?.status || null,
    raw: payload,
  };
}

export async function processCreatorPayoutTransfer(payout) {
  const recipient = await createTransferRecipient({
    name: payout.account_name || payout.creator_name,
    accountNumber: payout.account_number,
    bankCode: payout.bank_code,
  });

  const transfer = await initiateTransfer({
    amountNgn: payout.amount_ngn,
    recipientCode: recipient.recipientCode,
    reference: payout.paystack_reference,
    reason: `XStreamVideos creator payout ${payout.reference_id || payout.id}`,
  });

  return {
    ...transfer,
    recipientCode: recipient.recipientCode,
    recipientRaw: recipient.raw,
  };
}
