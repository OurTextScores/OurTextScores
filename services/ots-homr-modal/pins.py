"""Non-secret immutable release identities shared by build and runtime code."""

CORE_REPOSITORY = "jhlusko/OTS-homr"
CORE_REVISION = "1dbc87399c70238136da0dfd412fff032d17b76c"
CORE_ARTIFACT_SHA256 = (
    "1b2855ce3facea9aa8b0017f6e30143abd9aa43569a2f9ce1ab46bf8bf818fa3"
)
CORE_SHA256 = {
    "encoder.onnx": "f5b429929b17c375f2940739d00e04c62592f75afe4aeba6112859a6eb427aa1",
    "decoder.onnx": "7abc3ea71caac8f5a4fd9a96f0ce40c9f3b224ff83ed05899eae735c9917a1b4",
}
DETECTORS = {
    "lyrics": (
        "jhlusko/lyrics",
        "1bf2201d2eead54f78d79e2beba502b204614a92",
        "lyrics.pth",
        "7ff21020d5fefe5b774af71dd50610d1b05011f040c4b2c9c58f249b43f39804",
    ),
    "non-lyric-text": (
        "jhlusko/non-lyric-text",
        "9073adb53d901c90419f63b0f7e3fb4372ed18cc",
        "non-lyric-text.pth",
        "fcb8ca529fa355b0427112bda1c4edd95b2d6cc6c369be0c32f3313987a4ec82",
    ),
}
HEADS_REPOSITORY = "jhlusko/OTS-homr-additonal-heads"
HEADS_REVISION = "c3d4bb0430f0516665897c618f2e971d197630cc"
HEADS_CHECKPOINT_SHA256 = (
    "f6edb17ada2616b94330d8a20cff73e9e1e2a9cd77a8348b8543fde722552650"
)
HEADS_ONNX_SHA256 = "75d313e091d060723cc6bcec3edd1c7aecbe7beb2b637a8f6f4e50afad8e4db2"
MANIFEST_SHA256 = "7f92b9b948e6a39daef1f8bcdb66c8ebdfed2c38024ad532f292e0b4d04781fa"
TRAINING_REVISION = "c29cb63bfc9304def96870376e035feed0a4b461"
