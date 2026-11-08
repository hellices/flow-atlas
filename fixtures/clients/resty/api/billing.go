package api

import (
	"fmt"

	"github.com/go-resty/resty/v2"
)

type Invoice struct {
	ID     string `json:"id"`
	Amount int    `json:"amount"`
}

// Billing is the billing service's client. The gateway serves it under its own base path.
type Billing struct {
	http *resty.Client
}

// NewBilling returns the client of the billing service behind the gateway at gatewayURL (GATEWAY_URL in the app's
// environment).
func NewBilling(gatewayURL string) *Billing {
	return &Billing{http: resty.New().SetBaseURL(gatewayURL + "/billing/v1")}
}

func (b *Billing) Invoice(id string) (*Invoice, error) {
	invoice := &Invoice{}
	resp, err := b.http.R().
		SetPathParam("invoiceId", id).
		SetResult(invoice).
		Get("/invoices/{invoiceId}")
	return invoice, check(resp, err)
}

func (b *Billing) Refund(invoiceID string, line int) error {
	return check(b.http.R().
		SetBody(map[string]string{"reason": "requested_by_customer"}).
		Execute(resty.MethodPost, fmt.Sprintf("/invoices/%s/lines/%d/refund", invoiceID, line)))
}
