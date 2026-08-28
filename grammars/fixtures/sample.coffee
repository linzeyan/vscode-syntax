# Release helpers, CoffeeScript flavour.
fs = require 'fs'
{ join } = require 'path'

SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/

class Release
  constructor: (@tag, @assets = []) ->
    throw new Error "bad tag: #{@tag}" unless SEMVER.test @tag

  version: ->
    [_, major, minor, patch] = SEMVER.exec @tag
    (Number n for n in [major, minor, patch])

  toString: -> "#{@tag} (#{@assets.length} assets)"

loadAll = (dir) ->
  entries = fs.readdirSync dir
  releases = for name in entries when name.endsWith '.json'
    data = JSON.parse fs.readFileSync join(dir, name), 'utf8'
    new Release data.tag, data.assets ? []
  releases.sort (a, b) -> a.version()[1] - b.version()[1]

module.exports = { Release, loadAll, SEMVER }
