// Package users calls the users service with net/http's own functions, in the shapes the net/http documentation shows:
// http.Get, http.Head, http.Post and http.PostForm on a URL built by concatenation, fmt.Sprintf or url.JoinPath, and
// requests made with http.NewRequestWithContext and sent with a Client's Do.
package users

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
)

// base is the users service's URL, from the app's environment.
var base = os.Getenv("USERS_API_URL")

var client = &http.Client{}

type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Page struct {
	Users []User `json:"users"`
	Next  string `json:"next"`
}

func decode(resp *http.Response, err error, v any) error {
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %s", resp.Request.Method, resp.Request.URL, resp.Status)
	}
	if v == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func Health() error {
	resp, err := http.Head(base + "/health")
	return decode(resp, err, nil)
}

func Get(id string) (*User, error) {
	user := &User{}
	resp, err := http.Get(base + "/users/" + id)
	return user, decode(resp, err, user)
}

func Search(term string, page int) (*Page, error) {
	u, err := url.Parse(base + "/users/search")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	q.Set("q", term)
	q.Set("page", strconv.Itoa(page))
	u.RawQuery = q.Encode()
	result := &Page{}
	resp, err := http.Get(u.String())
	return result, decode(resp, err, result)
}

func Create(user User) (*User, error) {
	body, err := json.Marshal(user)
	if err != nil {
		return nil, err
	}
	created := &User{}
	resp, err := http.Post(base+"/users", "application/json", bytes.NewReader(body))
	return created, decode(resp, err, created)
}

func Login(username, password string) error {
	resp, err := http.PostForm(base+"/sessions", url.Values{"username": {username}, "password": {password}})
	return decode(resp, err, nil)
}

func Replace(ctx context.Context, id string, user User) error {
	endpoint, err := url.JoinPath(base, "users", id)
	if err != nil {
		return err
	}
	body, err := json.Marshal(user)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	return decode(resp, err, nil)
}

func Rename(ctx context.Context, id, name string) error {
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, fmt.Sprintf("%s/users/%s", base, id), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	return decode(resp, err, nil)
}

func Delete(ctx context.Context, id string) error {
	req, err := http.NewRequestWithContext(ctx, "DELETE", base+"/users/"+id, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	return decode(resp, err, nil)
}

func Report(year int) (map[string]any, error) {
	report := map[string]any{}
	resp, err := http.Get(fmt.Sprintf("%s/v2/reports/%d", base, year))
	return report, decode(resp, err, &report)
}
