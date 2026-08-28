#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, PolyLevel) {
    PolyLevelDebug = 0,
    PolyLevelInfo,
    PolyLevelError,
};

@interface PolyRelease : NSObject

@property (nonatomic, copy, readonly) NSString *tag;
@property (nonatomic, strong, readonly) NSArray<NSString *> *assets;

- (instancetype)initWithTag:(NSString *)tag assets:(NSArray<NSString *> *)assets NS_DESIGNATED_INITIALIZER;

@end

@implementation PolyRelease

- (instancetype)initWithTag:(NSString *)tag assets:(NSArray<NSString *> *)assets {
    if ((self = [super init])) {
        _tag = [tag copy];
        _assets = assets ?: @[];
    }
    return self;
}

- (NSString *)description {
    return [NSString stringWithFormat:@"%@ (%lu assets)", self.tag, (unsigned long)self.assets.count];
}

@end

NS_ASSUME_NONNULL_END
