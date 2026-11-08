// Package api calls the users service and the billing service with resty clients, in the shapes resty's README
// documents: a client configured once with its base URL, headers, auth token, client-level path parameters and a
// request middleware; requests with path parameters, a query, a body, form data, and each HTTP method.
package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"

	"github.com/go-resty/resty/v2"
)

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type UserPage struct {
	Users []User `json:"users"`
	Next  string `json:"next"`
}

type Report struct {
	Year  int `json:"year"`
	Total int `json:"total"`
}

// Users is the users service's client.
type Users struct {
	http *resty.Client
}

// NewUsers returns the client of the users service at baseURL (USERS_API_URL in the app's environment).
func NewUsers(baseURL, token string) *Users {
	client := resty.New().
		SetBaseURL(baseURL).
		SetHeader("Accept", "application/json").
		SetAuthToken(token).
		SetPathParam("version", "v2").
		OnBeforeRequest(func(c *resty.Client, r *resty.Request) error {
			r.SetHeader("X-Request-ID", requestID())
			return nil
		})
	return &Users{http: client}
}

func requestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func check(resp *resty.Response, err error) error {
	if err != nil {
		return err
	}
	if resp.IsError() {
		return fmt.Errorf("%s %s: %s", resp.Request.Method, resp.Request.URL, resp.Status())
	}
	return nil
}

func (u *Users) Health() error {
	return check(u.http.R().Head("/health"))
}

func (u *Users) Get(id string) (*User, error) {
	user := &User{}
	resp, err := u.http.R().
		SetPathParam("id", id).
		SetResult(user).
		Get("/users/{id}")
	return user, check(resp, err)
}

func (u *Users) List(term string, page int) (*UserPage, error) {
	result := &UserPage{}
	resp, err := u.http.R().
		SetQueryParams(map[string]string{
			"q":    term,
			"page": strconv.Itoa(page),
		}).
		SetResult(result).
		Get("/users")
	return result, check(resp, err)
}

func (u *Users) Create(user User) (*User, error) {
	created := &User{}
	resp, err := u.http.R().
		SetBody(user).
		SetResult(created).
		Post("/users")
	return created, check(resp, err)
}

func (u *Users) Replace(id string, user User) error {
	return check(u.http.R().
		SetPathParams(map[string]string{"id": id}).
		SetBody(user).
		Put("/users/{id}"))
}

func (u *Users) Rename(id, name string) error {
	return check(u.http.R().
		SetHeader("Content-Type", "application/json").
		SetBody(map[string]interface{}{"name": name}).
		Patch("/users/" + id))
}

func (u *Users) Delete(id string) error {
	return check(u.http.R().Delete(fmt.Sprintf("/users/%s", id)))
}

func (u *Users) GrantRole(id, role string) error {
	return check(u.http.R().
		SetPathParam("id", id).
		SetBody(map[string]string{"role": role}).
		Execute(resty.MethodPost, "/users/{id}/roles"))
}

func (u *Users) Login(username, password string) error {
	return check(u.http.R().
		SetFormData(map[string]string{"username": username, "password": password}).
		Post("/sessions"))
}

func (u *Users) Avatar(id, file string) error {
	return check(u.http.R().
		SetPathParam("id", id).
		SetRawPathParam("file", file).
		Get("/users/{id}/avatars/{file}"))
}

func (u *Users) Report(year int) (*Report, error) {
	report := &Report{}
	resp, err := u.http.R().
		SetPathParam("year", strconv.Itoa(year)).
		SetResult(report).
		Get("/{version}/reports/{year}")
	return report, check(resp, err)
}

func (u *Users) Capabilities() error {
	return check(u.http.R().Options("/users"))
}
