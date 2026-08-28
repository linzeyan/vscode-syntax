package main

import "fmt"

type User struct {
	ID   int
	Name string
}

func main() {
	u := User{ID: 1, Name: "poly"}
	fmt.Printf("Hello, %s (%d)\n", u.Name, u.ID)
}
