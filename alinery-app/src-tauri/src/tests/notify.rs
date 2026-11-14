//! Tests for notify.rs — the dock badge
//!
//! `use super::*` reaches the shared imports and fixtures in tests/mod.rs.

#[test]
fn dock_badge_value_uses_positive_counts_verbatim() {
    for count in [1, 2, 99, 100, i64::MAX] {
        assert_eq!(crate::dock_badge_value(count), Some(count));
    }
}

#[test]
fn dock_badge_value_removes_zero_and_negative_counts() {
    for count in [0, -1, i64::MIN] {
        assert_eq!(crate::dock_badge_value(count), None);
    }
}
