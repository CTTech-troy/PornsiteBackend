import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const jwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
): Promise<{ uid: string; email?: string }> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  const uid = payload.sub;
  if (!uid || typeof uid !== "string") throw new Error("Invalid token subject");
  return { uid, email: typeof payload.email === "string" ? payload.email : undefined };
}
