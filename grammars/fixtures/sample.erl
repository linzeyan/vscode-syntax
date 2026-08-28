-module(poly_release).

-export([version/1, latest/1, describe/1]).

-record(release, {tag :: binary(), assets = [] :: [binary()], prerelease = false :: boolean()}).

-type release() :: #release{}.

-define(SEMVER, "^v?([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-(.+))?$").

%% @doc Parse a semver tag into a {Major, Minor, Patch} tuple.
-spec version(binary()) -> {ok, {integer(), integer(), integer()}} | error.
version(Tag) ->
    case re:run(Tag, ?SEMVER, [{capture, all_but_first, list}]) of
        {match, [Major, Minor, Patch | _]} ->
            {ok, {list_to_integer(Major), list_to_integer(Minor), list_to_integer(Patch)}};
        nomatch ->
            error
    end.

-spec latest([release()]) -> release() | undefined.
latest(Releases) ->
    Stable = [R || R = #release{prerelease = false} <- Releases],
    case lists:sort(fun(A, B) -> version(A#release.tag) =< version(B#release.tag) end, Stable) of
        [] -> undefined;
        Sorted -> lists:last(Sorted)
    end.

describe(#release{tag = Tag, assets = Assets}) ->
    io_lib:format("~s (~p assets)", [Tag, length(Assets)]).
