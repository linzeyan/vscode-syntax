defmodule Poly.Release do
  @moduledoc """
  Parse and rank release tags.
  """

  @semver ~r/^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<pre>.+))?$/

  defstruct tag: nil, assets: [], prerelease?: false

  @type t :: %__MODULE__{tag: String.t(), assets: [String.t()], prerelease?: boolean()}

  @doc "Return `{major, minor, patch}` for `tag`, or `:error`."
  @spec version(String.t()) :: {:ok, {integer, integer, integer}} | :error
  def version(tag) do
    case Regex.named_captures(@semver, tag) do
      nil -> :error
      %{"major" => a, "minor" => b, "patch" => c} ->
        {:ok, {String.to_integer(a), String.to_integer(b), String.to_integer(c)}}
    end
  end

  def latest(releases) do
    releases
    |> Enum.reject(& &1.prerelease?)
    |> Enum.sort_by(fn %__MODULE__{tag: tag} ->
      case version(tag) do
        {:ok, v} -> v
        :error -> {0, 0, 0}
      end
    end)
    |> List.last()
  end

  defimpl String.Chars do
    def to_string(%Poly.Release{tag: tag, assets: assets}) do
      "#{tag} (#{length(assets)} assets)"
    end
  end
end
