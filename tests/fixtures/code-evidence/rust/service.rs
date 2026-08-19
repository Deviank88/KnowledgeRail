/* outer comment
   /* nested comment with fn fake() {} */
*/
const RAW: &str = r###"raw { text } // not code"###;

/// Service coordinates order work.
pub struct Service {
}

impl Service {
    /// Handle a borrowed order identifier.
    pub fn handle<'a>(&self, id: &'a str) {
        persist(id);
    }
}

#[test]
fn handles_order() {
    Service {}.handle("42");
}

macro_rules! audited {
    () => {
        fn fake_generated() {}
    };
}
