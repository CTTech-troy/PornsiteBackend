// =============================================================================
// Payment Service — ASP.NET Core Minimal API
// Providers: Paystack (international) · Monnify (NG)
// Reads secrets from paymentSystem/.env via DotNetEnv.
// Run: dotnet run  (uses PORT → PAYMENT_SERVICE_PORT → 10000; binds 0.0.0.0)
// =============================================================================

using System.Net.Http.Headers;
using System.Text;
using DotNetEnv;
using Microsoft.Extensions.Options;
using PaymentService;
using SysFile = System.IO.File;

// ---------------------------------------------------------------------------
// Load secrets from local payment .env (avoids DotNetEnv choking on the
// multiline Firebase JSON in the main backend/.env).
// ---------------------------------------------------------------------------
var envCandidates = new[]
{
    Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), ".env")),
    Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".env")),
    Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".env")),
};

var envFile = envCandidates.FirstOrDefault(SysFile.Exists);
if (envFile is not null)
{
    try
    {
        Env.Load(envFile);
        Console.WriteLine($"[config] Loaded secrets from {envFile}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[config] Could not parse {envFile}: {ex.Message} — falling back to system env vars");
    }
}
else
{
    Console.WriteLine("[config] No local .env found — using system environment variables");
}

// ---------------------------------------------------------------------------
var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<PaymentOptions>(builder.Configuration.GetSection("Payments"));
builder.Services.AddHttpClient();
builder.Services.AddMemoryCache();

builder.Services.AddTransient<IPaymentRouter, PaymentRouter>();
builder.Services.AddTransient<PaystackGateway>();
builder.Services.AddTransient<MonnifyGateway>();

// Render injects PORT dynamically; fall back to PAYMENT_SERVICE_PORT for local
// dev, then 10000 as a safe default.
var port = Environment.GetEnvironmentVariable("PORT")
    ?? Environment.GetEnvironmentVariable("PAYMENT_SERVICE_PORT")
    ?? "10000";

// Must bind to 0.0.0.0 so Render's port scanner can detect the open port.
// ListenLocalhost / localhost would only be visible inside the container.
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

var app = builder.Build();

var paymentOptions = app.Services.GetRequiredService<IOptions<PaymentOptions>>().Value;

// ---------------------------------------------------------------------------
// Startup connectivity check — printed to terminal on every launch
// ---------------------------------------------------------------------------
Console.WriteLine("\n┌─────────────────────────────────────────┐");
Console.WriteLine("│      Payment Provider Connectivity      │");
Console.WriteLine("└─────────────────────────────────────────┘");

// --- Paystack ---
try
{
    using var paystackClient = app.Services
        .GetRequiredService<IHttpClientFactory>()
        .CreateClient();

    paystackClient.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Bearer", paymentOptions.Paystack.SecretKey);

    using var paystackResp = await paystackClient.GetAsync(
        "https://api.paystack.co/bank?country=nigeria&perPage=1");

    if (paystackResp.IsSuccessStatusCode)
        Console.WriteLine("  ✓ Paystack  — Connected (test mode)");
    else
        Console.WriteLine($"  ✗ Paystack  — HTTP {(int)paystackResp.StatusCode} {paystackResp.ReasonPhrase}  (check PAYMENTS__PAYSTACK__SECRETKEY)");
}
catch (Exception ex)
{
    Console.WriteLine($"  ✗ Paystack  — {ex.Message}");
}

// --- Monnify ---
try
{
    using var monnifyClient = app.Services
        .GetRequiredService<IHttpClientFactory>()
        .CreateClient();

    var credentials = Convert.ToBase64String(
        Encoding.UTF8.GetBytes(
            $"{paymentOptions.Monnify.ApiKey}:{paymentOptions.Monnify.SecretKey}"));

    monnifyClient.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Basic", credentials);

    using var monnifyResp = await monnifyClient.PostAsync(
        $"{paymentOptions.Monnify.BaseUrl.TrimEnd('/')}/api/v1/auth/login",
        content: null);

    if (monnifyResp.IsSuccessStatusCode)
        Console.WriteLine("  ✓ Monnify   — Connected (sandbox)");
    else
        Console.WriteLine($"  ✗ Monnify   — HTTP {(int)monnifyResp.StatusCode} {monnifyResp.ReasonPhrase}  (check PAYMENTS__MONNIFY__APIKEY / SECRETKEY)");
}
catch (Exception ex)
{
    Console.WriteLine($"  ✗ Monnify   — {ex.Message}");
}

Console.WriteLine($"\n  Listening on http://0.0.0.0:{port}\n");

// ---------------------------------------------------------------------------
// POST /api/payments/create — called by Node.js to create a checkout session
// ---------------------------------------------------------------------------
app.MapPost("/api/payments/create", async (
    CreatePaymentRequest request,
    IPaymentRouter router,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.CountryCode))
        return Results.BadRequest(new { message = "CountryCode is required" });
    if (request.Amount <= 0)
        return Results.BadRequest(new { message = "Amount must be greater than zero" });
    if (string.IsNullOrWhiteSpace(request.Currency))
        return Results.BadRequest(new { message = "Currency is required" });

    try
    {
        var result = await router.CreateCheckoutAsync(request, ct);
        return Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.Problem(ex.Message, statusCode: 502);
    }
});

// ---------------------------------------------------------------------------
// GET /api/payments/health
// ---------------------------------------------------------------------------
app.MapGet("/api/payments/health", () =>
    Results.Ok(new { status = "ok", service = "payment-service", providers = new[] { "paystack", "monnify" } }));

// Root health probe — Render (and other platforms) hit /health by convention.
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

// ---------------------------------------------------------------------------
app.Run();
