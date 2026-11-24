//! The task model and its decisions. Adapters supply observations and apply effects.

pub mod acp;
mod command;
mod decision;
mod model;
pub mod profiles;

pub use command::{Answer, Command, CommandError};
pub use decision::{
    Action, CheckState, CloseWorkspace, Forge, Host, Launch, Observation, Observed, RetainedThread,
    RunState, WaitReason, Workspace, decide,
};
pub use model::{
    Acceptance, Authority, Brief, CallbackCredential, Entry, Head, Hold, HoldBy, Identity,
    InvalidHead, LaunchInputs, OperatorDecline, Phase, PreparedLaunch, PullRequest, Question,
    QuestionDelivery, Repair, Report, ReportAcceptance, ReportArtifact, ReportDelivery,
    ReportFailure, ReportTask, Review, Role, Run, Task, Threads, Verdict,
};
