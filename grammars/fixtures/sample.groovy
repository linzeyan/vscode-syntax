#!/usr/bin/env groovy
package com.example.poly

import groovy.transform.CompileStatic
import groovy.json.JsonSlurper

@CompileStatic
class ReleaseChecker {
    private static final String BASE = 'https://api.github.com/repos/linzeyan/vscode-syntax'

    String repo
    int expectedAssets = 16

    List<String> missing(Map release) {
        def names = (release.assets as List<Map>)*.name as List<String>
        def wanted = ['SHA256SUMS', 'THIRD-PARTY-NOTICES-cli.md']
        wanted.findAll { !(it in names) }
    }

    def verify(String tag) {
        def payload = new JsonSlurper().parseText(new URL("$BASE/releases/tags/$tag").text) as Map
        def gaps = missing(payload)
        if (gaps) {
            throw new IllegalStateException("missing assets: ${gaps.join(', ')}")
        }
        println "${tag}: ${(payload.assets as List).size()} assets OK"
    }
}

new ReleaseChecker(repo: 'vscode-syntax').verify('v0.2.0')
