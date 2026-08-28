(** Release metadata parsed from git tags. *)

type release = {
  tag : string;
  assets : string list;
  prerelease : bool;
}

exception Bad_tag of string

(** [version tag] returns [(major, minor, patch)].
    @raise Bad_tag when [tag] is not semver. *)
val version : string -> int * int * int

(** Newest non-prerelease entry, if any. *)
val latest : release list -> release option

val describe : release -> string
