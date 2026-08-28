(ns poly.release
  "Parse and rank release tags."
  (:require [clojure.string :as str]
            [clojure.set :refer [difference]]))

(def ^:private semver
  #"^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$")

(defrecord Release [tag assets prerelease?])

(defn parse
  "Return [major minor patch] for TAG, or nil when it is not semver."
  [tag]
  (when-let [[_ major minor patch] (re-matches semver tag)]
    (mapv #(Integer/parseInt %) [major minor patch])))

(defn latest [releases]
  (->> releases
       (remove :prerelease?)
       (sort-by (comp parse :tag))
       last))

(defn missing-assets [expected release]
  (difference (set expected) (set (:assets release))))

(comment
  (latest [(->Release "v0.1.0" ["poly"] false)
           (->Release "v0.2.0" ["poly" "SHA256SUMS"] false)
           (->Release "v0.3.0-rc.1" [] true)])
  ;; => #poly.release.Release{:tag "v0.2.0", ...}
  )
