(ns vinary-tree.installed-duallity-consumer
  (:require [vinary-tree.duallity :as duallity]
            ["@vinary-tree/javascript-runtime" :as runtime]))

(let [dictionary (.dynamicDawg (.-libdictenstein runtime))]
  (.put dictionary "cat" nil)
  (let [automaton (duallity/configured-wfst
                    dictionary "cat"
                    {:kind :generalized-standard
                     :maximum-distance 1
                     :cache-policy :lru
                     :cache-capacity 2
                     :operations [{:name "equal" :consume-x 1 :consume-y 1
                                   :weight 0 :applicability :equal}]})]
    (.close dictionary)
    (try
      (when-not (= "lru" (:cache-policy (duallity/wfst-options automaton)))
        (throw (js/Error. "ClojureScript lost the effective cache policy")))
      (when-not (:valid (duallity/state automaton (duallity/start automaton)))
        (throw (js/Error. "ClojureScript failed to walk the configured WFST")))
      (when-not (some? (:misses (duallity/cache-statistics automaton)))
        (throw (js/Error. "ClojureScript lost the cache statistics")))
      (duallity/clear-cache! automaton)
      (duallity/set-cache-policy! automaton :none)
      (when-not (= "none" (:cache-policy (duallity/wfst-options automaton)))
        (throw (js/Error. "ClojureScript failed to publish the new policy")))
      (js/console.log "installed ClojureScript configured WFST: pass")
      (finally
        (duallity/close! automaton)))))
