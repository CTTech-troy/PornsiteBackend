using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace PaymentService;

public sealed class MonnifyGateway
{
    private readonly IHttpClientFactory _http;
    private readonly PaymentOptions     _opts;
    private readonly IMemoryCache       _cache;

    private static readonly JsonSerializerOptions _json =
        new() { PropertyNameCaseInsensitive = true };

    public MonnifyGateway(
        IHttpClientFactory http,
        IOptions<PaymentOptions> opts,
        IMemoryCache cache)
    {
        _http  = http;
        _opts  = opts.Value;
        _cache = cache;
    }

    public async Task<CreatePaymentResponse> CreateCheckoutAsync(
        CreatePaymentRequest req, CancellationToken ct)
    {
        var token  = await GetAccessTokenAsync(ct);
        var client = _http.CreateClient();

        var paymentReference = $"REF-{req.OrderId}-{Guid.NewGuid():N}".ToUpperInvariant();

        var payload = new
        {
            amount             = req.Amount,
            customerName       = req.CustomerName,
            customerEmail      = req.CustomerEmail,
            paymentReference,
            paymentDescription = req.ProductName,
            currencyCode       = "NGN",
            contractCode       = _opts.Monnify.ContractCode,
            redirectUrl        = _opts.Monnify.RedirectUrl,
            paymentMethods     = new[] { "CARD", "ACCOUNT_TRANSFER", "USSD", "PHONE_NUMBER" },
            metaData           = new
            {
                orderId     = req.OrderId,
                userId      = req.UserId,
                planId      = req.PlanId,
                countryCode = req.CountryCode,
            },
        };

        using var httpReq = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_opts.Monnify.BaseUrl.TrimEnd('/')}/api/v1/merchant/transactions/init-transaction");

        httpReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        httpReq.Content = new StringContent(
            JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        using var resp = await client.SendAsync(httpReq, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);

        if (!resp.IsSuccessStatusCode)
            throw new Exception($"Monnify init-transaction failed ({resp.StatusCode}): {body}");

        var result = JsonSerializer.Deserialize<MonnifyInitResponse>(body, _json);
        var checkoutUrl = result?.ResponseBody?.CheckoutUrl
            ?? throw new Exception("Monnify response missing checkoutUrl");

        return new CreatePaymentResponse
        {
            Provider    = "monnify",
            CheckoutUrl = checkoutUrl,
            Reference   = result.ResponseBody!.TransactionReference ?? paymentReference,
        };
    }

    // -------------------------------------------------------------------------
    // Bearer token — cached until 30 s before expiry
    // -------------------------------------------------------------------------
    private const string CacheKey = "monnify_access_token";

    private async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        if (_cache.TryGetValue<string>(CacheKey, out var cached) &&
            !string.IsNullOrWhiteSpace(cached))
            return cached!;

        var client = _http.CreateClient();
        var credentials = Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"{_opts.Monnify.ApiKey}:{_opts.Monnify.SecretKey}"));

        using var req = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_opts.Monnify.BaseUrl.TrimEnd('/')}/api/v1/auth/login");
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", credentials);

        using var resp = await client.SendAsync(req, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);

        if (!resp.IsSuccessStatusCode)
            throw new Exception($"Monnify auth failed ({resp.StatusCode}): {body}");

        var authResult = JsonSerializer.Deserialize<MonnifyAuthResponse>(body, _json);
        var token      = authResult?.ResponseBody?.AccessToken
            ?? throw new Exception("Monnify auth response missing accessToken");

        var ttl = authResult.ResponseBody!.ExpiresIn;
        _cache.Set(CacheKey, token, TimeSpan.FromSeconds(Math.Max(60, ttl - 30)));
        return token;
    }

    // -------------------------------------------------------------------------
    // Private response models
    // -------------------------------------------------------------------------
    private sealed class MonnifyAuthResponse
    {
        public MonnifyAuthBody? ResponseBody { get; set; }
    }
    private sealed class MonnifyAuthBody
    {
        public string AccessToken { get; set; } = "";
        public int    ExpiresIn   { get; set; }
    }
    private sealed class MonnifyInitResponse
    {
        public MonnifyInitBody? ResponseBody { get; set; }
    }
    private sealed class MonnifyInitBody
    {
        public string CheckoutUrl          { get; set; } = "";
        public string TransactionReference { get; set; } = "";
    }
}
