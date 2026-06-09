package indexer

// BaseDelayMS is the base retry backoff delay (5 minutes). Ports BASE_DELAY_MS.
const BaseDelayMS int64 = 5 * 60 * 1000

// AttemptCap is the maximum number of accumulated failures before giving up.
// Ports ATTEMPT_CAP.
const AttemptCap int64 = 10

// ComputeRetryAfter returns the next retry timestamp for exponential backoff.
// attemptCount is the cumulative failure count including the current failure.
// When attemptCount >= AttemptCap it returns nil ("give up", retry_after=NULL):
// i.e. the 10th failure (attemptCount=10) yields nil → at most 9 retries.
// Otherwise it returns now + BaseDelayMS * 2^(attemptCount-1).
// Ports computeRetryAfter.
func ComputeRetryAfter(attemptCount, now int64) *int64 {
	if attemptCount >= AttemptCap {
		return nil
	}
	delay := BaseDelayMS * (1 << uint(attemptCount-1))
	v := now + delay
	return &v
}
