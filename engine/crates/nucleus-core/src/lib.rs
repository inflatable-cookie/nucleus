//! The task model and its decisions. Adapters supply observations and apply effects.

mod command;
mod decision;
mod model;

pub use command::{Answer, Command, CommandError};
pub use decision::{
    Action, CheckState, CloseWorkspace, Forge, Host, Launch, Observation, Observed, RetainedThread,
    RunState, WaitReason, Workspace, decide,
};
pub use model::{
    Acceptance, Authority, Brief, CallbackCredential, Entry, Head, Hold, Identity, InvalidHead,
    LaunchInputs, Phase, PreparedLaunch, PullRequest, Question, Repair, Report, Review, Role, Run,
    Task, Threads, Verdict,
};
