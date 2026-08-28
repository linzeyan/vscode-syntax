(* Parse and rank release tags. *)

type release = {
  tag : string;
  assets : string list;
  prerelease : bool;
}

exception Bad_tag of string

let semver = Str.regexp {|^v?\([0-9]+\)\.\([0-9]+\)\.\([0-9]+\)\(-.+\)?$|}

let version tag =
  if Str.string_match semver tag 0 then
    let group n = int_of_string (Str.matched_group n tag) in
    (group 1, group 2, group 3)
  else raise (Bad_tag tag)

let latest releases =
  releases
  |> List.filter (fun r -> not r.prerelease)
  |> List.sort (fun a b -> compare (version a.tag) (version b.tag))
  |> function [] -> None | xs -> Some (List.nth xs (List.length xs - 1))

let describe { tag; assets; _ } =
  Printf.sprintf "%s (%d assets)" tag (List.length assets)

let () =
  match latest [ { tag = "v0.1.0"; assets = []; prerelease = false } ] with
  | Some r -> print_endline (describe r)
  | None -> prerr_endline "no stable release"
