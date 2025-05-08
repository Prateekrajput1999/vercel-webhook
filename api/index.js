import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";
import crypto from "crypto";

// SNS payload type
/**
 * @typedef {Object} SNSPayload
 * @property {'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation'} Type
 * @property {string} [SubscribeURL]
 * @property {string} [Message]
 * @property {string} [MessageId]
 * @property {string} [Subject]
 * @property {string} [Timestamp]
 * @property {string} [TopicArn]
 * @property {string} [Token]
 * @property {string} [Signature]
 * @property {string} [SigningCertURL]
 */

/**
 * Verify SNS signature
 * @param {SNSPayload} body - The SNS payload
 * @returns {Promise<boolean>}
 */
async function verifySnsSignature(body) {
  console.log("Verifying SNS signature for body:", body);
  if (!body.Signature || !body.SigningCertURL) return false;
  try {
    const res = await fetch(body.SigningCertURL);
    console.log("res ok:", res.body);
    if (!res.ok) return false;
    const cert = await res.text();
    console.log("cert:", cert);
    let stringToSign = "";
    if (body.Type === "Notification") {
      console.log("inside Notification type");
      stringToSign += `Message\n${body.Message}\n`;
      if (body.MessageId) stringToSign += `MessageId\n${body.MessageId}\n`;
      if (body.Subject) stringToSign += `Subject\n${body.Subject}\n`;
      if (body.Timestamp) stringToSign += `Timestamp\n${body.Timestamp}\n`;
      if (body.TopicArn) stringToSign += `TopicArn\n${body.TopicArn}\n`;
      if (body.Type) stringToSign += `Type\n${body.Type}\n`;
    } else if (
      body.Type === "SubscriptionConfirmation" ||
      body.Type === "UnsubscribeConfirmation"
    ) {
      stringToSign += `Message\n${body.Message}\n`;
      if (body.MessageId) stringToSign += `MessageId\n${body.MessageId}\n`;
      if (body.SubscribeURL)
        stringToSign += `SubscribeURL\n${body.SubscribeURL}\n`;
      if (body.Timestamp) stringToSign += `Timestamp\n${body.Timestamp}\n`;
      if (body.Token) stringToSign += `Token\n${body.Token}\n`;
      if (body.TopicArn) stringToSign += `TopicArn\n${body.TopicArn}\n`;
      if (body.Type) stringToSign += `Type\n${body.Type}\n`;
    } else {
      return false;
    }

    if (stringToSign.endsWith("\n")) {
      stringToSign = stringToSign.slice(0, -1);
    }

    console.log("stringToSign:", stringToSign);

    const verifier = crypto.createVerify("RSA-SHA1");
    verifier.update(stringToSign, "utf8");
    return verifier.verify(cert, Buffer.from(body.Signature, "base64"));
  } catch (err) {
    console.warn("SNS signature verification failed:", err);
    return false;
  }
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Handle GET requests (healthcheck)
  if (req.method === "GET") {
    console.debug("[DEBUG] GET / called");
    return res.status(200).send("Hello, world!");
  }

  // Configure web-push VAPID details
  webpush.setVapidDetails(
    `mailto:${process.env.NOTIFICATIONS_FROM_EMAIL ?? "no-reply@example.com"}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  // Instantiate Supabase client with service-role key
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Parse the request body
    const payload = req.body;
    console.log("Received payload:", payload);
    const snsPayload = payload.source?.Type ? payload.source : payload;
    const msgType = req.headers["x-amz-sns-message-type"] || snsPayload.Type;
    console.log("Received SNS message type:", msgType);

    if (msgType === "SubscriptionConfirmation") {
      console.log("SNS message is a subscription confirmation ", snsPayload, typeof snsPayload, snsPayload?.SubscribeURL);
      if (snsPayload?.SubscribeURL) {
        try {
          const confirmRes = await fetch(snsPayload?.SubscribeURL);
          if (confirmRes.ok) {
            console.log(
              "SNS SubscriptionConfirmation fetch succeeded:",
              confirmRes.status
            );
          } else {
            console.warn(
              "SNS SubscriptionConfirmation fetch failed with status:",
              confirmRes.status
            );
          }
        } catch (err) {
          console.warn("SNS SubscriptionConfirmation fetch threw error:", err);
        }
      } else {
        console.warn(
          "SNS SubscriptionConfirmation received but no SubscribeURL present."
        );
      }
      return res.status(200).json({ success: true });
    }

    if (msgType === "Notification") {
      console.log("SNS message is a notification ", snsPayload);
      let message;
      try {
        message = JSON.parse(snsPayload.Message);
        console.log("Parsed message: ", message);
      } catch (err) {
        return res.status(400).json({ error: "Invalid SNS Message" });
      }

      let userAddress =
        message?.author ||
        message?.profile?.ownedBy ||
        message?.account ||
        message?.owner ||
        message?.accountId ||
        message?.followed_account ||
        message?.mentioned_account;

      let follower = message?.follower || null;
      if (!userAddress) {
        console.warn(
          "Could not determine userAddress from SNS payload",
          message
        );
        return res.status(200).json({ error: "No userAddress" });
      }

      if (follower) {
        console.log("Follower detected:", follower);
      }

      const title = "Lens Notification";
      const bodyText =
        message?.preview ||
        message?.content ||
        message?.body ||
        "You have a new notification";

      console.log("Fetching push subscriptions for user:", userAddress);
      const { data: subs, error } = await supabase
        .from("push_subscriptions")
        .select("endpoint, p256dh, auth")
        .ilike("user_address", userAddress);

      if (error) {
        console.error("DB error:", error);
        return res.status(500).json({ error: "DB error" });
      }

      console.log(
        `Found ${subs?.length || 0} subscriptions for user:`,
        userAddress,
        subs
      );

      const pushResults = await Promise.all(
        (subs || []).map(async (sub, idx) => {
          const pushSub = {
            endpoint: sub?.endpoint,
            keys: { p256dh: sub?.p256dh, auth: sub?.auth },
          };
          console.log(
            `Sending push notification #${idx + 1} to endpoint:`,
            sub
          );
          try {
            await webpush.sendNotification(
              pushSub,
              JSON.stringify({
                title,
                body: bodyText,
                icon: "/icon_192.webp",
                data: { url: "/notifications" },
              })
            );
            console.log(`Push notification #${idx + 1} sent successfully.`);
            return { success: true };
          } catch (err) {
            console.error(`Error sending push notification #${idx + 1}:`, err);
            return { success: false, error: err };
          }
        })
      );
      console.log("Push notification results:", pushResults);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: "Unsupported SNS message type" });
  } catch (error) {
    console.error("Error processing SNS message:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
