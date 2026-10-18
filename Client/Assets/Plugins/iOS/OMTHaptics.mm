// Native haptics bridge for HapticEngine (InputController.cs).
// Generators are created and prepared once so the first haptic of a run fires without warm-up latency.
#import <UIKit/UIKit.h>

static UIImpactFeedbackGenerator *sHeavy;
static UIImpactFeedbackGenerator *sLight;
static UIImpactFeedbackGenerator *sSoft;
static UIImpactFeedbackGenerator *sRigid;
static UINotificationFeedbackGenerator *sNotify;

enum OMTPattern {
    OMTPerfect = 0,
    OMTClean = 1,
    OMTClose = 2,
    OMTMiss = 3,
    OMTStreakMilestone = 4,
    OMTRingSpawn = 5,
};

static void OMTPrepareAll(void) {
    [sHeavy prepare];
    [sLight prepare];
    [sSoft prepare];
    [sRigid prepare];
    [sNotify prepare];
}

extern "C" {

void OMTHaptics_Prepare(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (sHeavy != nil) return;
        sHeavy = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleHeavy];
        sLight = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
        sSoft = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleSoft];
        sRigid = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleRigid];
        sNotify = [[UINotificationFeedbackGenerator alloc] init];
        OMTPrepareAll();
    });
}

void OMTHaptics_Play(int pattern) {
    // Unity calls from the main thread; UIKit feedback generators must be used on it.
    if (sHeavy == nil) return;
    switch (pattern) {
        case OMTPerfect:
            [sHeavy impactOccurredWithIntensity:1.0];
            break;
        case OMTClean:
            [sRigid impactOccurredWithIntensity:0.7];
            break;
        case OMTClose:
            [sSoft impactOccurredWithIntensity:0.5];
            break;
        case OMTMiss:
            [sNotify notificationOccurred:UINotificationFeedbackTypeWarning];
            break;
        case OMTStreakMilestone: {
            [sHeavy impactOccurredWithIntensity:0.8];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(90 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                [sHeavy impactOccurredWithIntensity:0.9];
            });
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(180 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                [sHeavy impactOccurredWithIntensity:1.0];
            });
            break;
        }
        case OMTRingSpawn:
            [sLight impactOccurredWithIntensity:0.3];
            break;
        default:
            break;
    }
    // Re-prepare so the next call stays low-latency.
    OMTPrepareAll();
}

}
