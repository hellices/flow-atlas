// Package billing is the billing service's client, written as Go API SDKs write theirs: a Client with a BaseURL and
// the http.Client it sends with, a newRequest that resolves a path against BaseURL, and one method per operation.
package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type Client struct {
	// BaseURL is where the billing API is served; paths are resolved against it, so it ends in "/".
	BaseURL    *url.URL
	HTTPClient *http.Client
	UserAgent  string
}

type Invoice struct {
	ID     string `json:"id"`
	Amount int    `json:"amount"`
}

type InvoiceList struct {
	Invoices []Invoice `json:"invoices"`
}

type ListOptions struct {
	Page    int
	PerPage int
}

// NewClient returns a client of the billing API at baseURL (BILLING_URL in the app's environment), version 1.
func NewClient(baseURL string, httpClient *http.Client) (*Client, error) {
	u, err := url.Parse(strings.TrimSuffix(baseURL, "/") + "/api/v1/")
	if err != nil {
		return nil, err
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{BaseURL: u, HTTPClient: httpClient, UserAgent: "billing-go"}, nil
}

func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	u, err := c.BaseURL.Parse(path)
	if err != nil {
		return nil, err
	}
	var buf io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), buf)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	return req, nil
}

func (c *Client) do(req *http.Request, v any) error {
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %s", req.Method, req.URL, resp.Status)
	}
	if v == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func (c *Client) ListInvoices(ctx context.Context, opts *ListOptions) (*InvoiceList, error) {
	path := "invoices"
	if opts != nil {
		q := url.Values{}
		q.Set("page", strconv.Itoa(opts.Page))
		q.Set("per_page", strconv.Itoa(opts.PerPage))
		path += "?" + q.Encode()
	}
	req, err := c.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	list := &InvoiceList{}
	return list, c.do(req, list)
}

func (c *Client) GetInvoice(ctx context.Context, id string) (*Invoice, error) {
	req, err := c.newRequest(ctx, http.MethodGet, fmt.Sprintf("invoices/%v", id), nil)
	if err != nil {
		return nil, err
	}
	invoice := &Invoice{}
	return invoice, c.do(req, invoice)
}

func (c *Client) CreateInvoice(ctx context.Context, invoice *Invoice) (*Invoice, error) {
	req, err := c.newRequest(ctx, http.MethodPost, "invoices", invoice)
	if err != nil {
		return nil, err
	}
	created := &Invoice{}
	return created, c.do(req, created)
}

func (c *Client) UpdateInvoice(ctx context.Context, id string, invoice *Invoice) error {
	req, err := c.newRequest(ctx, http.MethodPut, "invoices/"+id, invoice)
	if err != nil {
		return err
	}
	return c.do(req, nil)
}

func (c *Client) DeleteInvoice(ctx context.Context, id string) error {
	req, err := c.newRequest(ctx, http.MethodDelete, "invoices/"+id, nil)
	if err != nil {
		return err
	}
	return c.do(req, nil)
}

func (c *Client) RefundLine(ctx context.Context, invoiceID string, line int) error {
	req, err := c.newRequest(ctx, "POST", fmt.Sprintf("invoices/%v/lines/%d/refund", invoiceID, line), nil)
	if err != nil {
		return err
	}
	return c.do(req, nil)
}
