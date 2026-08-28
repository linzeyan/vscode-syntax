//! `poly --help` in English and Traditional Chinese.
//!
//! Only the usage text is translated. Diagnostics are not, and must not be:
//! the record `path:line:col: severity [tool/rule] message` is a contract that
//! CI annotation scripts and `rg` patterns parse, and half of every message
//! comes from an upstream tool that only speaks English anyway. A localised
//! severity word would break every consumer for no reader's benefit.

/// The languages the usage text exists in. Simplified Chinese is deliberately
/// absent rather than approximated with Traditional -- see `choose`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    En,
    ZhHant,
}

/// First non-empty of `POLY_LANG`, `LC_ALL`, `LC_MESSAGES`, `LANG`.
///
/// `POLY_LANG` is not a second mechanism, just the highest-priority source of
/// the same tag: a locale is a bad way to ask for a specific language when you
/// need one, and CI logs and tests need one fixed language whatever the runner
/// happens to be set to.
pub fn detect() -> Lang {
    let first = ["POLY_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty());
    choose(first.as_deref())
}

/// Traditional Chinese for `zh` tags that resolve to the Hant script, English
/// for everything else.
///
/// `zh-CN`, `zh-Hans` and `zh-SG` get English on purpose. Serving Traditional
/// to a Simplified reader is not a fallback, it is a different script; English
/// at least admits we do not have their language.
fn choose(tag: Option<&str>) -> Lang {
    // A POSIX locale is `lang[_REGION][.codeset][@modifier]`; a BCP 47 tag
    // uses `-`. Normalising both to lowercase dash-separated subtags means one
    // parse handles `zh_TW.UTF-8` and `zh-Hant-TW` alike.
    let tag = tag.unwrap_or_default();
    let tag = tag
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .to_lowercase();
    let mut subtags = tag.split(['-', '_']);
    if subtags.next() != Some("zh") {
        return Lang::En;
    }
    let hant = subtags.any(|s| matches!(s, "hant" | "tw" | "hk" | "mo"));
    if hant {
        Lang::ZhHant
    } else {
        Lang::En
    }
}

pub fn text(lang: Lang) -> String {
    let version = env!("CARGO_PKG_VERSION");
    match lang {
        Lang::En => format!(
            "poly {version} -- one formatter and linter for the whole repo

usage:
  poly fmt   [paths...] [flags]         format in place
  poly check [paths...] [flags]         run the linters
  poly tools <list|install> [tool...]   inspect or pre-fetch external tools
  poly lsp                              language server for the editor
  poly bench <file> [iters]             time the formatter on one file

flags:
  --check       report what would change, write nothing (fmt only)
  --strict      a missing tool is an error, not a skipped file
  --changed     only the files git reports as changed
  --compact     one line per issue, dropping the fix and docs lines
  --no-ignore   also visit files .gitignore and friends exclude
  --hidden      also visit dot-files and dot-directories (.git never)
  --version     print the version
  --help        print this

paths default to the current directory.
exit codes: 0 clean, 1 diffs or violations found, 2 error.
configuration: poly.toml -- every key is documented in poly.example.toml.
language: POLY_LANG=en or POLY_LANG=zh-TW (defaults to the system locale).
"
        ),
        Lang::ZhHant => format!(
            "poly {version} -- 一個 binary 管完整個 repo 的格式化與 lint

用法：
  poly fmt   [路徑...] [旗標]           就地格式化
  poly check [路徑...] [旗標]           跑 linter
  poly tools <list|install> [工具...]   查看或預先抓取外部工具
  poly lsp                              給編輯器用的 language server
  poly bench <檔案> [次數]              量單一檔案的格式化耗時

旗標：
  --check       只回報會改什麼，不寫檔（限 fmt）
  --strict      工具缺席視為錯誤，而不是跳過該檔
  --changed     只處理 git 回報有變更的檔案
  --compact     每個問題只印一行，不印 fix 與 docs
  --no-ignore   連 .gitignore 這類忽略檔排除的檔案也處理
  --hidden      連點開頭的檔案與目錄也處理（.git 一律不進）
  --version     印出版本
  --help        印出這份說明

沒給路徑時預設為當前目錄。
Exit code：0 乾淨、1 有差異或違規、2 執行錯誤。
設定檔：poly.toml——所有可填的鍵都寫在 poly.example.toml。
語言：POLY_LANG=en 或 POLY_LANG=zh-TW（未設定時看系統 locale）。
"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tag arrives in whatever shape the platform writes it: POSIX from a
    /// shell, BCP 47 from an explicit POLY_LANG. Both have to land on the same
    /// answer or the override would contradict the locale it overrides.
    #[test]
    fn traditional_chinese_locales_resolve_to_chinese() {
        for tag in [
            "zh_TW",
            "zh_TW.UTF-8",
            "zh-TW",
            "zh-Hant",
            "zh-Hant-TW",
            "zh_HK.UTF-8",
            "zh_MO",
            "ZH_TW",
        ] {
            assert_eq!(choose(Some(tag)), Lang::ZhHant, "{tag}");
        }
    }

    /// Simplified is a different script, not a near-miss to fall back to, and
    /// an unset or unrecognised locale is not a reason to guess.
    #[test]
    fn everything_else_resolves_to_english() {
        for tag in [
            "zh_CN.UTF-8",
            "zh-Hans",
            "zh_SG",
            "zh",
            "en_US.UTF-8",
            "C",
            "POSIX",
            "",
            "ja_JP",
            // `zho` is the ISO 639-2 code; locales in the wild use `zh`, and
            // matching a prefix instead of a whole subtag would also catch
            // languages that merely start with those letters.
            "zho_TW",
        ] {
            assert_eq!(choose(Some(tag)), Lang::En, "{tag}");
        }
        assert_eq!(choose(None), Lang::En);
    }

    /// Both texts describe the same binary. A flag documented in one language
    /// and not the other is how a translation silently goes stale.
    #[test]
    fn both_languages_document_every_flag() {
        let en = text(Lang::En);
        let zh = text(Lang::ZhHant);
        for token in [
            "fmt",
            "check",
            "tools",
            "lsp",
            "bench",
            "--check",
            "--strict",
            "--changed",
            "--compact",
            "--no-ignore",
            "--hidden",
            "--version",
            "--help",
            "poly.toml",
            "poly.example.toml",
            env!("CARGO_PKG_VERSION"),
        ] {
            assert!(en.contains(token), "English usage is missing {token}");
            assert!(zh.contains(token), "Chinese usage is missing {token}");
        }
    }
}
