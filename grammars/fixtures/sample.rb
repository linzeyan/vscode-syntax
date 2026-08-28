# frozen_string_literal: true

require "json"

module Poly
  class Release
    include Comparable

    SEMVER = /\Av?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<pre>[\w.]+))?\z/

    attr_reader :tag, :assets

    def initialize(tag, assets: [])
      raise ArgumentError, "bad tag: #{tag.inspect}" unless SEMVER.match?(tag)

      @tag = tag
      @assets = assets.freeze
    end

    def <=>(other)
      version <=> other.version
    end

    def version
      SEMVER.match(tag).captures.first(3).map(&:to_i)
    end

    def to_s = format("%s (%d assets)", tag, assets.size)
  end
end

releases = %w[v0.1.0 v0.2.0].map { |t| Poly::Release.new(t, assets: ["poly"]) }
puts releases.max.to_s
puts JSON.pretty_generate(releases.map { |r| { tag: r.tag, n: r.assets.size } })
