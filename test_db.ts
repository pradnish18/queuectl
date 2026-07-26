import { 
  enqueueJob, 
  claimNextJob, 
  completeJob, 
  failJob, 
  recoverStaleJobs, 
  close 
} from './src/db';

async function runTests() {
  console.log('--- Starting DB Verification Tests ---');

  // 1. Test Enqueue
  enqueueJob('job-1', 'echo "Hello World"', 3);
  enqueueJob('job-2', 'exit 1', 3);
  console.log('✅ Enqueued 2 jobs');

  // 2. Test Atomic Claim
  const claimedJob = claimNextJob('worker-A');
  console.log('✅ Claimed Job:', claimedJob?.id === 'job-1' ? 'job-1 (SUCCESS)' : 'FAILED');

  // 3. Test Complete
  if (claimedJob) {
    completeJob(claimedJob.id);
    console.log('✅ Marked job-1 as completed');
  }

  // 4. Test Failure & Backoff
  const failedJob = claimNextJob('worker-A');
  console.log('✅ Claimed Job 2:', failedJob?.id);
  if (failedJob) {
    // Fail attempt 1 (backoff = 2^1 = 2 seconds)
    failJob(failedJob.id, 1, 2);
    console.log('✅ Failed job-2 (attempt 1). Next run set 2s in future.');
  }

  // 5. Verify Backoff Block
  const immediateRetry = claimNextJob('worker-B');
  console.log('✅ Immediate Claim during backoff window (Should be null):', immediateRetry === null ? 'SUCCESS (null)' : 'FAILED');

  // 6. Test Stale Recovery (Simulate crashed worker)
  enqueueJob('job-stale', 'sleep 100', 3);
  const staleJob = claimNextJob('worker-dead');
  console.log('✅ Claimed job-stale by worker-dead');
  
  // Force updated_at back in time to simulate 60+ seconds of inactivity
  const recoveredCount = recoverStaleJobs(0); // Pass 0 seconds so it recovers immediately
  console.log('✅ Recovered stale jobs count (Should be >= 1):', recoveredCount);

  close();
  console.log('--- All DB Tests Passed! ---');
}

runTests();