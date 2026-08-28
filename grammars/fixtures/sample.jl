module PolyBench

using Statistics: median

export summarize, Timing

"""
    Timing(name, samples)

Latency samples for one formatter, in milliseconds.
"""
struct Timing{T<:Real}
    name::String
    samples::Vector{T}
end

p95(t::Timing) = sort(t.samples)[max(1, ceil(Int, 0.95 * length(t.samples)))]

function summarize(timings::Vector{<:Timing}; budget = 200.0)
    for t in timings
        over = p95(t) > budget ? " OVER BUDGET" : ""
        @info "$(t.name): median=$(round(median(t.samples), digits=1))ms p95=$(round(p95(t), digits=1))ms$over"
    end
    return all(t -> p95(t) <= budget, timings)
end

const DEFAULTS = Dict{Symbol,Any}(:budget => 200.0, :warmup => 3)

end # module
