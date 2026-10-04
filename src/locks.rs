//! Poison-tolerant lock access. A panic while a lock is held poisons it; the data behind
//! every daemon lock stays valid across such a panic, so we recover the guard instead of
//! panicking again (which would kill the calling thread, e.g. the sync scheduler).

use std::sync::{Condvar, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

pub fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn read<T: ?Sized>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn write<T: ?Sized>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// `Condvar::wait` that recovers the guard when the mutex was poisoned.
pub fn wait<'a, T>(cv: &Condvar, guard: MutexGuard<'a, T>) -> MutexGuard<'a, T> {
    cv.wait(guard)
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
