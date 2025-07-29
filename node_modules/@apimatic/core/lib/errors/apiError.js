"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadResult = exports.ApiError = void 0;
var tslib_1 = require("tslib");
var json_bigint_1 = tslib_1.__importDefault(require("@apimatic/json-bigint"));
var convert_to_stream_1 = require("@apimatic/convert-to-stream");
/**
 * Thrown when the HTTP status code is not okay.
 *
 * The ApiError extends the ApiResponse interface, so all ApiResponse
 * properties are available.
 */
var ApiError = /** @class */ (function (_super) {
    tslib_1.__extends(ApiError, _super);
    function ApiError(context, message) {
        var _newTarget = this.constructor;
        var _this = _super.call(this, message) || this;
        Object.setPrototypeOf(_this, _newTarget.prototype);
        var request = context.request, response = context.response;
        _this.request = request;
        _this.statusCode = response.statusCode;
        _this.headers = response.headers;
        _this.body = response.body;
        return _this;
    }
    return ApiError;
}(Error));
exports.ApiError = ApiError;
function loadResult(error) {
    return tslib_1.__awaiter(this, void 0, void 0, function () {
        var _a, error_1;
        return tslib_1.__generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    _a = error;
                    return [4 /*yield*/, parseBody(error.body)];
                case 1:
                    _a.result = _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    error_1 = _b.sent();
                    if (process.env.NODE_ENV !== 'production' && console) {
                        // tslint:disable-next-line:no-console
                        console.warn("Unexpected error: Could not parse HTTP response body. ".concat(error_1.message));
                    }
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
exports.loadResult = loadResult;
function parseBody(body) {
    return tslib_1.__awaiter(this, void 0, void 0, function () {
        var jsonString, jsonBig;
        return tslib_1.__generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, (0, convert_to_stream_1.convertFromStream)(body)];
                case 1:
                    jsonString = _a.sent();
                    if (body === '') {
                        return [2 /*return*/, undefined];
                    }
                    jsonBig = (0, json_bigint_1.default)();
                    return [2 /*return*/, jsonBig.parse(jsonString)];
            }
        });
    });
}
