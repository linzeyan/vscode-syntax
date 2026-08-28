# Summarize CI durations by workflow.
library(stats)

runs <- data.frame(
  workflow = c("CI", "Build", "CI", "Build", "CI"),
  minutes = c(4.1, 9.8, 0.7, 9.8, 5.2),
  ok = c(TRUE, TRUE, TRUE, FALSE, TRUE),
  stringsAsFactors = FALSE
)

summarize <- function(df, threshold = 5.0) {
  by_wf <- split(df$minutes, df$workflow)
  out <- sapply(by_wf, function(x) c(n = length(x), median = median(x), max = max(x)))
  slow <- names(which(out["median", ] > threshold))
  if (length(slow) > 0L) {
    warning(sprintf("slow workflows: %s", paste(slow, collapse = ", ")))
  }
  t(out)
}

result <- summarize(runs[runs$ok, ])
print(result)
cat(sprintf("failures: %d\n", sum(!runs$ok)))
