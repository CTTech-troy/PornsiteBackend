using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace PaymentService;

public sealed class PaystackGateway
{
    private readonly IHttpClientFactory _http;
    private readonly PaymentOptions     _opts;

    private static readonly JsonSerializerOptions _json =
        new() { PropertyNameCaseInsensitive = true };

    public PaystackGateway(IHttpClientFactory http, IOptions<PaymentOptions> opts)
    {
        _http = http;
        _opts = opts.Value;
    }

    public async Task<CreatePaymentResponse> CreateCheckoutAsync(
        CreatePaymentRequest req, CancellationToken ct)
    {
        var client    = _http.CreateClient();
        var reference = $"PAY-{req.OrderId}-{Guid.NewGuid():N}".ToUpperInvariant();

        // Paystack expects amount in the smallest currency unit (kobo for NGN, cents for USD/GBP…)
        var amountInSubunit = (long)(req.Amount * 100);

        var payload = new
        {
            email        = req.CustomerEmail,
            amount       = amountInSubunit,
            currency     = req.Currency.ToUpperInvariant(),
            reference,
            callback_url = _opts.Paystack.CallbackUrl,
            metadata     = new
            {
                order_id     = req.OrderId,
                user_id      = req.UserId,
                plan_id      = req.PlanId,
                country_code = req.CountryCode,
                cancel_action = _opts.Paystack.CancelUrl,
                custom_fields = new[]
                {
                    new { display_name = "Plan",    variable_name = "plan_id",  value = req.PlanId  },
                    new { display_name = "User ID", variable_name = "user_id",  value = req.UserId  },
                },
            },
        };

        using var httpReq = new HttpRequestMessage(
            HttpMethod.Post,
            "https://api.paystack.co/transaction/initialize");

        httpReq.Headers.Authorization =
            new AuthenticationHeaderValue("Bearer", _opts.Paystack.SecretKey);
        httpReq.Content = new StringContent(
            JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        using var resp = await client.SendAsync(httpReq, ct);
        var body = await resp.Content.ReadAsStringAsync(ct);

        if (!resp.IsSuccessStatusCode)
            throw new Exception($"Paystack initialize failed ({resp.StatusCode}): {body}");

        var result = JsonSerializer.Deserialize<PaystackInitResponse>(body, _json);
        if (result?.Status != true)
            throw new Exception($"Paystack error: {result?.Message ?? body}");

        var checkoutUrl = result.Data?.AuthorizationUrl
            ?? throw new Exception("Paystack response missing authorization_url");

        return new CreatePaymentResponse
        {
            Provider    = "paystack",
            CheckoutUrl = checkoutUrl,
            Reference   = result.Data?.Reference ?? reference,
        };
    }

    // -------------------------------------------------------------------------
    // Private response models
    // -------------------------------------------------------------------------
    private sealed class PaystackInitResponse
    {
        public bool    Status  { get; set; }
        public string? Message { get; set; }
        public PaystackInitData? Data { get; set; }
    }

    private sealed class PaystackInitData
    {
        public string AuthorizationUrl { get; set; } = "";
        public string AccessCode       { get; set; } = "";
        public string Reference        { get; set; } = "";
    }
}
