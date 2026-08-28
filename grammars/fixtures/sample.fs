module Poly.Release

open System
open System.Text.RegularExpressions

let private semver = Regex(@"^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$", RegexOptions.Compiled)

type Level =
    | Debug
    | Info
    | Error

type Release =
    { Tag: string
      Assets: string list
      Prerelease: bool }

    member this.Version =
        let m = semver.Match this.Tag
        if not m.Success then failwithf "bad tag: %s" this.Tag
        [ 1; 2; 3 ] |> List.map (fun i -> int m.Groups.[i].Value)

let latest releases =
    releases
    |> List.filter (fun r -> not r.Prerelease)
    |> List.sortBy (fun r -> r.Version)
    |> List.tryLast

let describe level (r: Release) =
    match level with
    | Debug -> sprintf "%s %A" r.Tag r.Assets
    | Info -> sprintf "%s (%d assets)" r.Tag (List.length r.Assets)
    | Error -> String.Format("{0}: FAILED", r.Tag)
