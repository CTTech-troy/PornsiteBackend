namespace PaymentService;

// ---------------------------------------------------------------------------
// Configuration POCOs
// ---------------------------------------------------------------------------

public sealed class PaymentOptions
{
    public PaystackOptions Paystack { get; set; } = new();
    public MonnifyOptions  Monnify  { get; set; } = new();
}

public sealed class PaystackOptions
{
    public string SecretKey   { get; set; } = "";
    public string PublicKey   { get; set; } = "";
    public string CallbackUrl { get; set; } = "";
    public string CancelUrl   { get; set; } = "";
}

public sealed class MonnifyOptions
{
    public string BaseUrl             { get; set; } = "https://sandbox.monnify.com";
    public string ApiKey              { get; set; } = "";
    public string SecretKey           { get; set; } = "";
    public string ContractCode        { get; set; } = "";
    public string WalletAccountNumber { get; set; } = "";
    public string RedirectUrl         { get; set; } = "";
}

// ---------------------------------------------------------------------------
// Request / Response DTOs
// ---------------------------------------------------------------------------

public sealed class CreatePaymentRequest
{
    /// <summary>Composite key: "{userId}:{planId}:{timestamp}"  — parsed by webhooks.</summary>
    public string OrderId        { get; set; } = "";
    public string UserId         { get; set; } = "";
    public string PlanId         { get; set; } = "";
    public string CountryCode    { get; set; } = "";
    public string Currency       { get; set; } = "";
    public decimal Amount        { get; set; }
    public string ProductName    { get; set; } = "";
    public string CustomerEmail  { get; set; } = "";
    public string CustomerName   { get; set; } = "";
    public string CustomerPhone  { get; set; } = "";
}

public sealed class CreatePaymentResponse
{
    public string Provider    { get; set; } = "";   // "stripe" | "monnify"
    public string CheckoutUrl { get; set; } = "";
    public string Reference   { get; set; } = "";
}

// ---------------------------------------------------------------------------
// Router interface
// ---------------------------------------------------------------------------

public interface IPaymentRouter
{
    Task<CreatePaymentResponse> CreateCheckoutAsync(CreatePaymentRequest request, CancellationToken ct);
}

public sealed class PaymentRouter : IPaymentRouter
{
    private readonly PaystackGateway _paystack;
    private readonly MonnifyGateway  _monnify;

    public PaymentRouter(PaystackGateway paystack, MonnifyGateway monnify)
    {
        _paystack = paystack;
        _monnify  = monnify;
    }

    public Task<CreatePaymentResponse> CreateCheckoutAsync(CreatePaymentRequest request, CancellationToken ct)
    {
        var country = (request.CountryCode ?? "").Trim().ToUpperInvariant();
        return country == "NG"
            ? _monnify.CreateCheckoutAsync(request, ct)
            : _paystack.CreateCheckoutAsync(request, ct);
    }
}
