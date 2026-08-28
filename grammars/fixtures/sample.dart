import 'dart:async';
import 'dart:convert';

/// A published release and its assets.
class Release implements Comparable<Release> {
  const Release(this.tag, {this.assets = const []});

  final String tag;
  final List<String> assets;

  static final _semver = RegExp(r'^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$');

  List<int> get version {
    final m = _semver.firstMatch(tag);
    if (m == null) throw FormatException('bad tag', tag);
    return [1, 2, 3].map((i) => int.parse(m.group(i)!)).toList();
  }

  @override
  int compareTo(Release other) => '$version'.compareTo('${other.version}');

  @override
  String toString() => '$tag (${assets.length} assets)';
}

Future<List<Release>> load(Stream<String> lines) async {
  final out = <Release>[];
  await for (final line in lines) {
    final json = jsonDecode(line) as Map<String, dynamic>;
    out.add(Release(json['tag'] as String, assets: List<String>.from(json['assets'] ?? [])));
  }
  return out..sort();
}
