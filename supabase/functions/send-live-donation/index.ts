import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { verifyFirebaseIdToken } from "../_shared/firebase_jwt.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Body = {
  stream_id: string;
  creator_id: string;
  amount?: number;
  gift_type?: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const firebaseProjectId = Deno.env.get("FIREBASE_PROJECT_ID") ?? "";
    if (!supabaseUrl || !serviceKey) {
      return json({ error: "Server misconfigured" }, 500);
    }
    if (!firebaseProjectId) {
      return json({ error: "FIREBASE_PROJECT_ID not set on Edge Function" }, 500);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m?.[1]) {
      return json({ error: "Missing Authorization Bearer token" }, 401);
    }

    const { uid: senderId } = await verifyFirebaseIdToken(m[1], firebaseProjectId);

    const body = (await req.json()) as Body;
    const streamId = String(body.stream_id ?? "").trim();
    const creatorId = String(body.creator_id ?? "").trim();
    const giftType = body.gift_type ? String(body.gift_type).trim() : null;

    if (!streamId || !creatorId) {
      return json({ error: "stream_id and creator_id required" }, 400);
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    let amount = typeof body.amount === "number" ? body.amount : NaN;
    if (giftType) {
      const { data: row, error: gErr } = await supabase
        .from("gift_catalog")
        .select("price")
        .eq("gift_type", giftType)
        .maybeSingle();
      if (gErr || !row?.price) {
        return json({ error: "Unknown gift_type" }, 400);
      }
      amount = Number(row.price);
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "Valid amount or gift_type required" }, 400);
    }

    const minAmount = Number(Deno.env.get("LIVE_DONATION_MIN_AMOUNT") ?? "1");
    const maxAmount = Number(Deno.env.get("LIVE_DONATION_MAX_AMOUNT") ?? "1000000");
    if (amount < minAmount || amount > maxAmount) {
      return json({ error: `Amount must be between ${minAmount} and ${maxAmount}` }, 400);
    }

    const { data: rpcData, error: rpcErr } = await supabase.rpc("process_live_donation", {
      p_stream_id: streamId,
      p_sender_id: senderId,
      p_creator_id: creatorId,
      p_amount: amount,
      p_gift_type: giftType,
    });

    if (rpcErr) {
      console.error("[send-live-donation] rpc", rpcErr);
      const msg = rpcErr.message ?? "Donation failed";
      const code = /insufficient balance/i.test(msg) ? 402 : /cannot donate|creator mismatch|invalid/i.test(msg) ? 400 : 500;
      return json({ error: msg }, code);
    }

    const result = rpcData as Record<string, unknown>;
    if (!result?.ok) {
      return json({ error: "Donation failed" }, 500);
    }

    const channelName = `live-donations:${streamId}`;
    const rt = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });

    const broadcastPayload = { ...result, sender_id: senderId };
    await new Promise<void>((resolve) => {
      const ch = rt.channel(channelName);
      const done = () => {
        try {
          rt.removeChannel(ch);
        } catch (_) { /* ignore */ }
        resolve();
      };
      const timer = setTimeout(done, 8000);
      ch.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ch.send({
            type: "broadcast",
            event: "donation",
            payload: broadcastPayload,
          })
            .catch((err) => console.warn("[send-live-donation] send", err))
            .finally(() => {
              clearTimeout(timer);
              done();
            });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          done();
        }
      });
    }).catch((err) => {
      console.warn("[send-live-donation] broadcast", err);
    });

    return json({ success: true, data: result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/jwt|token|expired|signature/i.test(msg)) {
      return json({ error: "Invalid or expired token" }, 401);
    }
    console.error("[send-live-donation]", e);
    return json({ error: msg }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
